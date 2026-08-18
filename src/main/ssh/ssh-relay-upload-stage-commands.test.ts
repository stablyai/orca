import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getRemoteHostPlatform, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  cleanupOwnedRelayUploadStageCommand,
  parseReservedRelayUploadStage,
  promoteOwnedRelayUploadStageCommand,
  recoverOneStaleRelayUploadStageCommand,
  relayUploadStagePromotionConfirmed,
  reserveRelayUploadStageCommand,
  RELAY_UPLOAD_STAGE_SLOT_COUNT
} from './ssh-relay-upload-stage-commands'

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')
const owner = '.sftp-namespace-123e4567e89b12d3a456426614174000'
const roots: string[] = []
const configuredPowerShell = process.env.ORCA_POWERSHELL_EXECUTABLE
const powerShellExecutable = [
  configuredPowerShell,
  ...(process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh'])
].find(
  (candidate) =>
    candidate &&
    spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      stdio: 'ignore'
    }).status === 0
)

function decodePowerShellCommand(command: string): string {
  const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/u)?.[1] ?? ''
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

function createPool(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-upload-stage-pool-'))
  roots.push(root)
  const pool = join(root, 'pool')
  mkdirSync(pool)
  return pool
}

function runCommand(host: RemoteHostPlatform, command: string, prefix = '') {
  if (host.commandDialect === 'powershell') {
    if (!powerShellExecutable) {
      throw new Error('PowerShell is unavailable')
    }
    return spawnSync(
      powerShellExecutable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${prefix}\n${decodePowerShellCommand(command)}`
      ],
      { encoding: 'utf8' }
    )
  }
  return spawnSync('/bin/sh', ['-c', `${prefix}\n${command}`], { encoding: 'utf8' })
}

function createStage(
  host: RemoteHostPlatform,
  pool: string,
  index: number,
  stageOwner = owner,
  stale = false,
  state: 'slot' | 'claim' | 'delete' = 'slot'
): string {
  const reservedOwner = /^\.sftp-namespace-[0-9a-f]{32}$/u.test(stageOwner) ? stageOwner : owner
  const reservation = runCommand(host, reserveRelayUploadStageCommand(host, pool, reservedOwner))
  expect(reservation.status, reservation.stderr).toBe(0)
  const slot = join(pool, `slot-${index}`)
  const stage = join(pool, `${state}-${index}`)
  if (stage !== slot) {
    expect(existsSync(stage)).toBe(false)
    renameSync(slot, stage)
  }
  const marker = join(stage, '.orca-upload-owner')
  if (stageOwner !== reservedOwner) {
    writeFileSync(marker, stageOwner)
  }
  writeFileSync(join(stage, 'payload', 'relay.js'), `relay-${index}`)
  if (stale) {
    const old = new Date(Date.now() - 60 * 60_000)
    utimesSync(marker, old, old)
  }
  return stage
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// Why: every case spawns a real interpreter per command, and on non-Windows hosts the PowerShell
// path also forks `/usr/bin/stat` per file-identity lookup — the 8-entry reservation alone measured
// ~50s idle, nearly all of it process-spawn sys time, and the full suite multiplies that under CPU
// contention. Sized for spawn count, not the assertions, which run in microseconds.
const SPAWNED_INTERPRETER_TIMEOUT_MS = 240_000

describe.each([
  ['POSIX', posix] as const,
  ...((powerShellExecutable ? [['PowerShell', windows] as const] : []) as (readonly [
    string,
    RemoteHostPlatform
  ])[])
])(
  '%s relay upload stage commands',
  { timeout: SPAWNED_INTERPRETER_TIMEOUT_MS },
  (_label, host) => {
    it.each([0, 1, 7, 8, 9])('bounds reservation with %i occupied entries', (count) => {
      const pool = createPool()
      for (let index = 0; index < Math.min(count, RELAY_UPLOAD_STAGE_SLOT_COUNT); index += 1) {
        createStage(host, pool, index)
      }
      if (count > RELAY_UPLOAD_STAGE_SLOT_COUNT) {
        mkdirSync(join(pool, 'foreign-extra'))
      }

      const result = runCommand(host, reserveRelayUploadStageCommand(host, pool, owner))
      if (count < RELAY_UPLOAD_STAGE_SLOT_COUNT) {
        expect(result.status, result.stderr).toBe(0)
        expect(parseReservedRelayUploadStage(host, pool, owner, result.stdout).slotName).toBe(
          `slot-${count}`
        )
      } else {
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('staging quota is full')
      }
    })

    it('promotes only the post-claim owned payload and removes its fixed stage', () => {
      const pool = createPool()
      const destination = join(pool, 'destination')
      mkdirSync(destination)
      createStage(host, pool, 0)
      const stage = parseReservedRelayUploadStage(
        host,
        pool,
        owner,
        `noise\n__ORCA_UPLOAD_STAGE_SLOT__${owner}:slot-0\n`
      )

      const result = runCommand(
        host,
        promoteOwnedRelayUploadStageCommand(host, stage, owner, destination)
      )

      expect(result.status, result.stderr).toBe(0)
      expect(relayUploadStagePromotionConfirmed(owner, result.stdout)).toBe(true)
      expect(readFileSync(join(destination, 'relay.js'), 'utf8')).toBe('relay-0')
      expect(existsSync(join(pool, 'slot-0'))).toBe(false)
      expect(existsSync(join(pool, 'claim-0'))).toBe(false)
      expect(existsSync(join(pool, 'delete-0'))).toBe(false)
    })

    // Why: symlink creation in the fixture needs privileges Windows CI doesn't grant.
    it.skipIf(process.platform === 'win32')(
      'rejects a payload reparse point without copying or deleting it',
      () => {
        const pool = createPool()
        const destination = join(pool, 'destination')
        const foreign = join(pool, 'foreign.js')
        mkdirSync(destination)
        const stagePath = createStage(host, pool, 0)
        rmSync(join(stagePath, 'payload', 'relay.js'))
        writeFileSync(foreign, 'foreign')
        symlinkSync(foreign, join(stagePath, 'payload', 'relay.js'))
        const stage = parseReservedRelayUploadStage(
          host,
          pool,
          owner,
          `__ORCA_UPLOAD_STAGE_SLOT__${owner}:slot-0`
        )

        const result = runCommand(
          host,
          promoteOwnedRelayUploadStageCommand(host, stage, owner, destination)
        )

        expect(result.status, result.stderr).toBe(0)
        expect(relayUploadStagePromotionConfirmed(owner, result.stdout)).toBe(false)
        expect(existsSync(join(destination, 'relay.js'))).toBe(false)
        expect(lstatSync(join(pool, 'slot-0', 'payload', 'relay.js')).isSymbolicLink()).toBe(true)
        expect(readFileSync(foreign, 'utf8')).toBe('foreign')
      }
    )

    it('reclaims one stale owned stage but preserves fresh and foreign stages', () => {
      const pool = createPool()
      createStage(host, pool, 0, owner, false)
      createStage(host, pool, 1, '.foreign-owner', true)
      createStage(host, pool, 2, owner, true)

      const result = runCommand(host, recoverOneStaleRelayUploadStageCommand(host, pool, 60))

      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(join(pool, 'slot-0'))).toBe(true)
      expect(existsSync(join(pool, 'slot-1'))).toBe(true)
      expect(existsSync(join(pool, 'slot-2'))).toBe(false)
    })

    it('drains fixed stale claim and delete states across repeated deployments', () => {
      const pool = createPool()
      createStage(host, pool, 0, owner, true, 'claim')
      createStage(host, pool, 1, owner, true, 'delete')

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = runCommand(host, recoverOneStaleRelayUploadStageCommand(host, pool, 60))
        expect(result.status, result.stderr).toBe(0)
      }

      expect(existsSync(join(pool, 'claim-0'))).toBe(false)
      expect(existsSync(join(pool, 'delete-1'))).toBe(false)
    })
  }
)

describe('POSIX ownership race fencing', () => {
  it('restores a replacement directory and preserves the original moved aside before claim', () => {
    const pool = createPool()
    const destination = join(pool, 'destination')
    mkdirSync(destination)
    createStage(posix, pool, 0)
    const stage = parseReservedRelayUploadStage(
      posix,
      pool,
      owner,
      `__ORCA_UPLOAD_STAGE_SLOT__${owner}:slot-0`
    )
    const prefix = [
      'raced=0',
      'mv() {',
      'if [ "$raced" -eq 0 ]; then',
      'raced=1; command mv "$1" "$1.original"; mkdir "$1"; mkdir "$1/payload"; cp "$1.original/.orca-upload-owner" "$1/.orca-upload-owner"; cp "$1.original/.orca-upload-identity" "$1/.orca-upload-identity"; touch -t 202001010000 "$1/.orca-upload-owner"; printf foreign > "$1/foreign";',
      'fi;',
      'command mv "$@";',
      '}'
    ].join('\n')

    const result = runCommand(
      posix,
      promoteOwnedRelayUploadStageCommand(posix, stage, owner, destination),
      prefix
    )

    expect(result.status, result.stderr).toBe(0)
    expect(relayUploadStagePromotionConfirmed(owner, result.stdout)).toBe(false)
    expect(existsSync(join(pool, 'slot-0', 'foreign'))).toBe(true)
    expect(existsSync(join(pool, 'slot-0.original', '.orca-upload-owner'))).toBe(true)
    expect(existsSync(join(destination, 'relay.js'))).toBe(false)
  })

  it('restores a replacement symlink without touching its target', () => {
    const pool = createPool()
    const destination = join(pool, 'destination')
    const foreign = join(pool, 'foreign')
    mkdirSync(destination)
    mkdirSync(foreign)
    writeFileSync(join(foreign, 'sentinel'), 'alive')
    createStage(posix, pool, 0)
    const stage = parseReservedRelayUploadStage(
      posix,
      pool,
      owner,
      `__ORCA_UPLOAD_STAGE_SLOT__${owner}:slot-0`
    )
    const prefix = [
      'raced=0',
      'mv() {',
      'if [ "$raced" -eq 0 ]; then raced=1; command mv "$1" "$1.original"; ln -s ' +
        `'${foreign}' "$1"; fi;`,
      'command mv "$@";',
      '}'
    ].join('\n')

    const result = runCommand(
      posix,
      cleanupOwnedRelayUploadStageCommand(posix, stage, owner),
      prefix
    )

    expect(result.status, result.stderr).toBe(0)
    expect(lstatSync(join(pool, 'slot-0')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(foreign, 'sentinel'), 'utf8')).toBe('alive')
    expect(existsSync(join(pool, 'slot-0.original', '.orca-upload-owner'))).toBe(true)
  })
})

describe.runIf(powerShellExecutable)(
  'PowerShell ownership race fencing',
  { timeout: SPAWNED_INTERPRETER_TIMEOUT_MS },
  () => {
    it('restores an old same-owner replacement whose persisted file ID does not match', () => {
      const pool = createPool()
      const destination = join(pool, 'destination')
      mkdirSync(destination)
      createStage(windows, pool, 0)
      const stage = parseReservedRelayUploadStage(
        windows,
        pool,
        owner,
        `__ORCA_UPLOAD_STAGE_SLOT__${owner}:slot-0`
      )
      const prefix = [
        '$script:raced = $false',
        'function Move-Item {',
        'param($LiteralPath, $Destination, $ErrorAction)',
        'if (-not $script:raced) {',
        '$script:raced = $true',
        'Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination ($LiteralPath + ".original") -ErrorAction Stop',
        '$null = New-Item -ItemType Directory -Path $LiteralPath',
        '$null = New-Item -ItemType Directory -Path (Join-Path $LiteralPath "payload")',
        '$newPath = (Get-Item -LiteralPath $LiteralPath).FullName',
        '$originalPath = (Get-Item -LiteralPath ($LiteralPath + ".original")).FullName',
        '[System.IO.File]::WriteAllText((Join-Path $newPath ".orca-upload-owner"), [System.IO.File]::ReadAllText((Join-Path $originalPath ".orca-upload-owner")))',
        '[System.IO.File]::WriteAllText((Join-Path $newPath ".orca-upload-identity"), [System.IO.File]::ReadAllText((Join-Path $originalPath ".orca-upload-identity")))',
        '(Get-Item -LiteralPath (Join-Path $newPath ".orca-upload-owner") -Force).LastWriteTimeUtc = [DateTime]::UtcNow.AddHours(-2)',
        '[System.IO.File]::WriteAllText((Join-Path $newPath "foreign"), "foreign")',
        '}',
        'Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination -ErrorAction $ErrorAction',
        '}'
      ].join('\n')

      const result = runCommand(
        windows,
        promoteOwnedRelayUploadStageCommand(windows, stage, owner, destination),
        prefix
      )

      expect(result.status, result.stderr).toBe(0)
      expect(relayUploadStagePromotionConfirmed(owner, result.stdout)).toBe(false)
      expect(existsSync(join(pool, 'slot-0', 'foreign'))).toBe(true)
      expect(existsSync(join(pool, 'slot-0.original', '.orca-upload-owner'))).toBe(true)
      expect(existsSync(join(destination, 'relay.js'))).toBe(false)
    })
  }
)

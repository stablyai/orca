/**
 * Upload-stage file identity on Windows through a verified pinned node.exe instead of the legacy
 * Add-Type helper (design D5, docs/reference/windows-edr-posture.md).
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'
import {
  cleanupOwnedRelayUploadStageCommand,
  parseReservedRelayUploadStage,
  promoteOwnedRelayUploadStageCommand,
  recoverOneStaleRelayUploadStageCommand,
  relayUploadStagePromotionConfirmed,
  reserveRelayUploadStageCommand,
  type WindowsUploadStageIdentity
} from './ssh-relay-upload-stage-commands'
import { WINDOWS_UPLOAD_STAGE_IDENTITY_JS } from './ssh-relay-upload-stage-windows-commands'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'

const windows = getRemoteHostPlatform('win32-x64')
const owner = '.sftp-namespace-123e4567e89b12d3a456426614174000'
const pool = 'C:/Users/ada/.orca-remote/.upload-stages'
const pinned: WindowsUploadStageIdentity = {
  node: 'C:/Users/ada/.orca-remote/runtimes/node-abc/node.exe'
}
const stage = parseReservedRelayUploadStage(
  windows,
  pool,
  owner,
  `__ORCA_UPLOAD_STAGE_SLOT__${owner}:slot-3`
)
const roots: string[] = []

function allCommands(identity?: WindowsUploadStageIdentity): string[] {
  return [
    reserveRelayUploadStageCommand(windows, pool, owner, identity),
    promoteOwnedRelayUploadStageCommand(windows, stage, owner, `${pool}/../relay-x`, identity),
    cleanupOwnedRelayUploadStageCommand(windows, stage, owner, identity),
    recoverOneStaleRelayUploadStageCommand(windows, pool, undefined, identity)
  ].map(decodeRemotePowerShellScript)
}

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-stage-identity-'))
  roots.push(root)
  return root
}

function nodeIdentity(path: string): string {
  const result = spawnSync(process.execPath, ['-e', WINDOWS_UPLOAD_STAGE_IDENTITY_JS, '--', path], {
    encoding: 'utf8'
  })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    removeTreeSync(root)
  }
})

describe('Windows upload-stage identity commands', () => {
  it('compile nothing once a verified node.exe is known', () => {
    for (const script of allCommands(pinned)) {
      expect(script).not.toMatch(/Add-Type|DllImport|ExecutionPolicy|\.ps1/)
      expect(script).toContain(`$orcaIdentityNode = '${pinned.node}'`)
    }
  })

  it('keep the Add-Type helper only for relays with no verified node.exe', () => {
    for (const script of allCommands()) {
      expect(script).toContain('Add-Type -TypeDefinition')
      expect(script).not.toContain('$orcaIdentityNode')
    }
  })

  it('run node.exe with the fixed script and the path as an argument', () => {
    const script = allCommands(pinned)[0]
    const lines = script.split('\n').filter((line) => line.includes('OrcaFileIdentity'))
    expect(lines).toMatchInlineSnapshot(`
      [
        "function ConvertTo-OrcaFileIdentity([string]$value) { (($value.Trim().ToLowerInvariant() -split ':') | ForEach-Object { $digits = $_.TrimStart('0'); if ($digits -eq '') { '0' } else { $digits } }) -join ':' }",
        "$getFileIdentity = { param($path) $value = & $orcaIdentityNode -e 'const s=require(''fs'').lstatSync(process.argv[1],{bigint:true});const m=0xffffffffn;process.stdout.write((s.dev&m).toString(16)+'':''+(s.ino>>32n).toString(16)+'':''+(s.ino&m).toString(16))' -- $path; if ($LASTEXITCODE -ne 0) { throw 'Orca could not read a relay upload stage file identity' }; ConvertTo-OrcaFileIdentity ([string]$value) }",
      ]
    `)
  })
})

describe('the pinned node.exe identity script', () => {
  it("prints the legacy helper's vol:indexHigh:indexLow lowercase hex", () => {
    const dir = tempDir()
    const stats = lstatSync(dir, { bigint: true })
    const mask = 0xffffffffn
    expect(nodeIdentity(dir)).toBe(
      `${(stats.dev & mask).toString(16)}:${(stats.ino >> 32n).toString(16)}:${(stats.ino & mask).toString(16)}`
    )
    expect(nodeIdentity(dir)).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/)
  })

  it('survives the claim rename but not a copy with the same contents', () => {
    const root = tempDir()
    const slot = join(root, 'slot-0')
    mkdirSync(slot)
    const before = nodeIdentity(slot)
    renameSync(slot, join(root, 'claim-0'))
    expect(nodeIdentity(join(root, 'claim-0'))).toBe(before)
    cpSync(join(root, 'claim-0'), join(root, 'copy'), { recursive: true })
    expect(nodeIdentity(join(root, 'copy'))).not.toBe(before)
  })
})

const powerShell = [
  process.env.ORCA_POWERSHELL_EXECUTABLE,
  ...(process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['pwsh'])
].find(
  (candidate) =>
    candidate &&
    spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      stdio: 'ignore'
    }).status === 0
)

function runPowerShell(command: string): { status: number | null; stdout: string } {
  const result = spawnSync(
    powerShell!,
    ['-NoProfile', '-NonInteractive', '-Command', decodeRemotePowerShellScript(command)],
    { encoding: 'utf8' }
  )
  expect(result.status, result.stderr).toBe(0)
  return result
}

function reserve(localPool: string, identity?: WindowsUploadStageIdentity): string {
  const out = runPowerShell(reserveRelayUploadStageCommand(windows, localPool, owner, identity))
  const reserved = parseReservedRelayUploadStage(windows, localPool, owner, out.stdout)
  writeFileSync(join(reserved.slotDir, 'payload', 'relay.js'), 'relay')
  return reserved.slotName
}

function promote(localPool: string, slotName: string, identity?: WindowsUploadStageIdentity) {
  const destination = join(localPool, '..', 'relay-x')
  mkdirSync(destination, { recursive: true })
  const reserved = parseReservedRelayUploadStage(
    windows,
    localPool,
    owner,
    `__ORCA_UPLOAD_STAGE_SLOT__${owner}:${slotName}`
  )
  const out = runPowerShell(
    promoteOwnedRelayUploadStageCommand(windows, reserved, owner, destination, identity)
  )
  return {
    promoted: relayUploadStagePromotionConfirmed(owner, out.stdout),
    copied: existsSync(join(destination, 'relay.js'))
  }
}

describe.runIf(powerShell)('Windows upload-stage identity (real PowerShell)', () => {
  const node = { node: process.execPath }

  it('reserves and promotes through node.exe alone', { timeout: 120_000 }, () => {
    const localPool = join(tempDir(), 'pool')
    const slot = reserve(localPool, node)
    expect(promote(localPool, slot, node)).toEqual({ promoted: true, copied: true })
  })

  it('accepts an identity file in any hex spelling of the same file', { timeout: 120_000 }, () => {
    const localPool = join(tempDir(), 'pool')
    const slot = reserve(localPool, node)
    const identityFile = join(localPool, slot, '.orca-upload-identity')
    const [vol, high, low] = readFileSync(identityFile, 'utf8').split(':')
    writeFileSync(identityFile, `${vol.toUpperCase()}:000${high}:${low.toUpperCase()}\r\n`)
    expect(promote(localPool, slot, node)).toEqual({ promoted: true, copied: true })
  })

  // Why Windows only: off Windows the legacy branch reads `stat %i`, a different format.
  it.runIf(process.platform === 'win32')(
    'reads identity files the legacy Add-Type helper wrote, and the reverse',
    { timeout: 240_000 },
    () => {
      const oldToNew = join(tempDir(), 'pool')
      expect(promote(oldToNew, reserve(oldToNew), node)).toEqual({ promoted: true, copied: true })
      const newToOld = join(tempDir(), 'pool')
      expect(promote(newToOld, reserve(newToOld, node))).toEqual({ promoted: true, copied: true })
    }
  )
})

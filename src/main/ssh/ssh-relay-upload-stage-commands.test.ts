import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import {
  listStaleRemoteUploadStagesCommand,
  parseStaleRemoteUploadStageListing,
  removeStaleRemoteUploadStagesCommand,
  STALE_UPLOAD_STAGE_OUTPUT_PREFIX
} from './ssh-relay-upload-stage-commands'

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')
const powerShellExecutable = (
  process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh']
).find(
  (candidate) =>
    spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      stdio: 'ignore'
    }).status === 0
)
const candidateCounts = [0, 1, 7, 8, 9] as const

function decodePowerShellCommand(command: string): string {
  const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)?.[1] ?? ''
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

function createStaleStageFixture(count: number): {
  relayDir: string
  stages: string[]
  root: string
} {
  const root = mkdtempSync(join(tmpdir(), 'orca-stage-listing-'))
  const relayDir = join(root, 'relay-1.0.0')
  const stages = Array.from(
    { length: count },
    (_, index) => `${relayDir}.upload-123e4567-e89b-12d3-a456-${String(index).padStart(12, '0')}`
  )
  const staleDate = new Date(Date.now() - 3 * 60 * 60_000)
  for (const stage of stages) {
    mkdirSync(stage)
    utimesSync(stage, staleDate, staleDate)
  }
  return { relayDir, stages, root }
}

describe('stale relay upload stage commands', () => {
  it.each(candidateCounts)('lists %i POSIX candidates with successful bounded output', (count) => {
    const fixture = createStaleStageFixture(count)
    try {
      const command = listStaleRemoteUploadStagesCommand(posix, fixture.relayDir, 2 * 60 * 60, 8)
      const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
      const parsed = parseStaleRemoteUploadStageListing(posix, fixture.relayDir, result.stdout)

      expect(result.status, result.stderr).toBe(0)
      expect(parsed).toHaveLength(Math.min(count, 8))
      expect(fixture.stages).toEqual(expect.arrayContaining(parsed))
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  describe.runIf(powerShellExecutable)('PowerShell listing', () => {
    it.each(candidateCounts)('lists %i candidates with successful bounded output', (count) => {
      const fixture = createStaleStageFixture(count)
      try {
        const script = decodePowerShellCommand(
          listStaleRemoteUploadStagesCommand(windows, fixture.relayDir, 2 * 60 * 60, 8)
        )
        const result = spawnSync(
          powerShellExecutable!,
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { encoding: 'utf8' }
        )
        const parsed = parseStaleRemoteUploadStageListing(windows, fixture.relayDir, result.stdout)

        expect(result.status, result.stderr).toBe(0)
        expect(parsed).toHaveLength(Math.min(count, 8))
        expect(fixture.stages).toEqual(expect.arrayContaining(parsed))
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    })
  })

  it('rejects unframed stdout noise and rechecks a framed fresh stage before deletion', () => {
    const fixture = createStaleStageFixture(1)
    const freshStage = `${fixture.relayDir}.upload-123e4567-e89b-12d3-a456-999999999999`
    mkdirSync(freshStage)
    try {
      const listing = [
        'startup banner',
        fixture.stages[0],
        `${STALE_UPLOAD_STAGE_OUTPUT_PREFIX}/foreign/path`,
        `${STALE_UPLOAD_STAGE_OUTPUT_PREFIX}${freshStage}`,
        `${STALE_UPLOAD_STAGE_OUTPUT_PREFIX}${fixture.stages[0]}`
      ].join('\n')
      const parsed = parseStaleRemoteUploadStageListing(posix, fixture.relayDir, listing)

      expect(parsed).toEqual([freshStage, fixture.stages[0]])
      const cleanup = spawnSync(
        '/bin/sh',
        ['-c', removeStaleRemoteUploadStagesCommand(posix, fixture.relayDir, parsed, 2 * 60 * 60)],
        { encoding: 'utf8' }
      )
      expect(cleanup.status, cleanup.stderr).toBe(0)
      expect(existsSync(freshStage)).toBe(true)
      expect(existsSync(fixture.stages[0])).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('returns nonzero without candidate stdout when POSIX enumeration fails', () => {
    const fixture = createStaleStageFixture(1)
    try {
      const command = listStaleRemoteUploadStagesCommand(posix, fixture.relayDir, 2 * 60 * 60, 8)
      const result = spawnSync('/bin/sh', ['-c', `find() { return 23; }\n${command}`], {
        encoding: 'utf8'
      })

      expect(result.status).not.toBe(0)
      expect(result.stdout).not.toContain(STALE_UPLOAD_STAGE_OUTPUT_PREFIX)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('restores a stage refreshed between its age check and atomic rename claim', () => {
    const fixture = createStaleStageFixture(1)
    try {
      const command = removeStaleRemoteUploadStagesCommand(
        posix,
        fixture.relayDir,
        fixture.stages,
        2 * 60 * 60
      )
      const result = spawnSync(
        '/bin/sh',
        ['-c', `mv() { touch "$1"; command mv "$@"; }\n${command}`],
        { encoding: 'utf8' }
      )

      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(fixture.stages[0])).toBe(true)
      expect(readdirSync(fixture.root).some((name) => name.includes('.cleanup-'))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('does not delete a fresh same-path replacement nominated as stale', () => {
    const fixture = createStaleStageFixture(1)
    try {
      const command = removeStaleRemoteUploadStagesCommand(
        posix,
        fixture.relayDir,
        fixture.stages,
        2 * 60 * 60
      )
      const result = spawnSync(
        '/bin/sh',
        [
          '-c',
          `raced=0\nmv() { if [ "$raced" -eq 0 ]; then raced=1; command mv "$1" "$1.replaced"; mkdir "$1"; fi; command mv "$@"; }\n${command}`
        ],
        { encoding: 'utf8' }
      )

      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(fixture.stages[0])).toBe(true)
      expect(existsSync(`${fixture.stages[0]}.replaced`)).toBe(true)
      expect(readdirSync(fixture.root).some((name) => name.includes('.cleanup-'))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('restores the claimed stage when tombstone deletion fails', () => {
    const fixture = createStaleStageFixture(1)
    try {
      const command = removeStaleRemoteUploadStagesCommand(
        posix,
        fixture.relayDir,
        fixture.stages,
        2 * 60 * 60
      )
      const result = spawnSync('/bin/sh', ['-c', `rm() { return 1; }\n${command}`], {
        encoding: 'utf8'
      })

      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(fixture.stages[0])).toBe(true)
      expect(readdirSync(fixture.root).some((name) => name.includes('.cleanup-'))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.runIf(powerShellExecutable)(
    'restores a PowerShell stage refreshed before the atomic rename claim',
    () => {
      const fixture = createStaleStageFixture(1)
      try {
        const command = decodePowerShellCommand(
          removeStaleRemoteUploadStagesCommand(
            windows,
            fixture.relayDir,
            fixture.stages,
            2 * 60 * 60
          )
        )
        const refreshMove =
          'function Move-Item { param($LiteralPath, $Destination, $ErrorAction) (Get-Item -LiteralPath $LiteralPath).LastWriteTimeUtc = [DateTime]::UtcNow; Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination -ErrorAction $ErrorAction }'
        const result = spawnSync(
          powerShellExecutable!,
          ['-NoProfile', '-NonInteractive', '-Command', `${refreshMove}\n${command}`],
          { encoding: 'utf8' }
        )

        expect(result.status, result.stderr).toBe(0)
        expect(existsSync(fixture.stages[0])).toBe(true)
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }
  )

  it.runIf(powerShellExecutable)(
    'returns nonzero without candidate stdout when PowerShell enumeration fails',
    () => {
      const fixture = createStaleStageFixture(1)
      try {
        const command = decodePowerShellCommand(
          listStaleRemoteUploadStagesCommand(windows, fixture.relayDir, 2 * 60 * 60, 8)
        )
        const result = spawnSync(
          powerShellExecutable!,
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `function Get-ChildItem { throw 'injected listing failure' }\n${command}`
          ],
          { encoding: 'utf8' }
        )

        expect(result.status).not.toBe(0)
        expect(result.stdout).not.toContain(STALE_UPLOAD_STAGE_OUTPUT_PREFIX)
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }
  )
})

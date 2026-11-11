import type * as NodeChildProcess from 'node:child_process'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const { execFileSyncMock, statSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  statSyncMock: vi.fn()
}))

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  statSync: statSyncMock,
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn()
}))

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFileSync: execFileSyncMock,
  execFile: vi.fn(),
  spawn: vi.fn()
}))

describe('createSetupRunnerScript', () => {
  it.skipIf(process.platform === 'win32')(
    'runs a script whose shebang carries invocation-only bash flags',
    async () => {
      // Reapplying login/interactive flags through set would abort before the first user line.
      const { buildPosixRunnerScript } = await import('./setup-runner-script-text')
      const { mkdtempSync, rmSync, writeFileSync } = await vi.importActual<typeof NodeFs>('node:fs')
      const { execFileSync } = await vi.importActual<typeof NodeChildProcess>('node:child_process')

      const dir = mkdtempSync(join(tmpdir(), 'orca-posix-runner-'))
      try {
        const runnerPath = join(dir, 'setup-runner.sh')
        writeFileSync(
          runnerPath,
          buildPosixRunnerScript('#!/bin/bash -l\necho SETUP_RAN\n'),
          'utf-8'
        )

        expect(execFileSync('bash', [runnerPath], { encoding: 'utf-8' })).toContain('SETUP_RAN')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})

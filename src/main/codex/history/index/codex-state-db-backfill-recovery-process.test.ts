import { ChildProcess } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { spawnCodexBackfillRecoveryProcess } from './codex-state-db-backfill-recovery-process'

const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.unstubAllEnvs()
})

it('spawns System32 wsl.exe when recovering a WSL Codex home on Windows', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.stubEnv('SystemRoot', 'D:\\Windows')
  const spawnMock = vi.fn(() => new ChildProcess())

  spawnCodexBackfillRecoveryProcess(
    '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.codex',
    spawnMock,
    () => 'codex'
  )

  expect(spawnMock).toHaveBeenCalledWith(
    'D:\\Windows\\System32\\wsl.exe',
    expect.arrayContaining(['-d', 'Ubuntu']),
    expect.objectContaining({ windowsHide: true })
  )
})

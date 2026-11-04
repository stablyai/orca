import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const mocks = vi.hoisted(() => ({
  runProcess: vi.fn(),
  runFsProcess: vi.fn(async (..._args: unknown[]): Promise<unknown> => []),
  readFsProcess: vi.fn(async (..._args: unknown[]) => Buffer.from('x'))
}))

vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))
vi.mock('./wsl-transcript-fs-process-dispatch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runWslTranscriptFsProcess: mocks.runFsProcess,
  openWslTranscriptFsProcess: async () => ({ wslTranscriptFsProcessHandle: 1 }),
  readWslTranscriptFsProcess: mocks.readFsProcess,
  isWslTranscriptFsProcessHandle: () => true,
  closeWslTranscriptFsProcess: async () => {}
}))

import { _resetWslCachesForTests } from '../wsl/discovery/distro-catalog'
import {
  _resetWslBackgroundDistroGateForTests,
  noteWslDistroMayHaveStopped
} from '../wsl/discovery/wsl-background-distro-gate'
import { openTranscriptFile, readTranscriptFile } from './wsl-transcript-fs-access'
import { resetWslTranscriptFsGateForTests } from './wsl-transcript-fs-gate'

const SESSIONS = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects'

function runningList(...distros: string[]): ProcessResult {
  const stdout = distros.map((distro) => `${distro}\n`).join('')
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

let originalPlatform: NodeJS.Platform

beforeEach(() => {
  originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  mocks.runProcess.mockReset()
  mocks.runFsProcess.mockReset().mockResolvedValue([])
  mocks.readFsProcess.mockClear()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  _resetWslCachesForTests()
  _resetWslBackgroundDistroGateForTests()
  resetWslTranscriptFsGateForTests()
  vi.useRealTimers()
})

describe('transcript reads never boot a stopped WSL distro (E9)', () => {
  it('never reads an already-open handle of a distro that stopped since the open', async () => {
    mocks.runProcess.mockResolvedValue(runningList('Ubuntu'))
    const file = `${SESSIONS}\\s.jsonl`
    const handle = await openTranscriptFile(file, 'exact')

    noteWslDistroMayHaveStopped('Ubuntu')
    mocks.runProcess.mockResolvedValue(runningList())

    await expect(
      readTranscriptFile(handle, file, Buffer.alloc(1), 0, 1, 0, 'exact')
    ).rejects.toThrow('is not running')
    expect(mocks.readFsProcess).not.toHaveBeenCalled()
  })
})

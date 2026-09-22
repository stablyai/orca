import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type * as NodeFsPromisesModule from 'node:fs/promises'

const UNC_DATA_DIR = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\opencode'
const UNC_DATABASE = `${UNC_DATA_DIR}\\opencode.db`

const mocks = vi.hoisted(() => ({
  resolveDataDirectory: vi.fn<() => string>(),
  readdir: vi.fn(),
  stat: vi.fn()
}))

vi.mock('../opencode/opencode-data-directory', () => ({
  resolveOpenCodeDataDirectory: mocks.resolveDataDirectory
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  readdir: mocks.readdir,
  stat: mocks.stat
}))

import { listOpenCodeDatabases } from './opencode-database-discovery'
import {
  resetWslTranscriptFsGateForTests,
  WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS,
  WslTranscriptFsError
} from '../native-chat/wsl-transcript-fs-gate'

// A stalled task holds the gate's single scan slot until it settles, so every
// case releases its stall before the next one runs.
let releaseStall: (() => void) | undefined

function stalls<T>(): Promise<T> {
  return new Promise<T>((resolve) => {
    releaseStall = () => resolve([] as T)
  })
}

// Complete: UNC readdir results pass through the child dispatcher's dirent
// serializer, which reads every kind flag.
function dirent(name: string) {
  return {
    name,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => false,
    isFIFO: () => false,
    isFile: () => true,
    isSocket: () => false,
    isSymbolicLink: () => false
  }
}

// The point of the gate: an ungated syscall on a stalled 9P mount never returns,
// so the call must still be pending at the deadline and settle just after it.
async function settlesOnlyAtTheScanDeadline(pending: Promise<string[]>): Promise<string[]> {
  let settled = false
  const tracked = pending.then((value) => {
    settled = true
    return value
  })
  await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS - 1)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(2)
  return await tracked
}

let originalDatabaseOverride: string | undefined

beforeEach(() => {
  // blockedRoutes is persistent gate state: a prior stall must not quarantine
  // this test's route.
  resetWslTranscriptFsGateForTests()
  originalDatabaseOverride = process.env.OPENCODE_DB
  delete process.env.OPENCODE_DB
  mocks.resolveDataDirectory.mockReset()
  mocks.readdir.mockReset()
  mocks.stat.mockReset()
  releaseStall = undefined
  mocks.resolveDataDirectory.mockReturnValue(UNC_DATA_DIR)
  vi.useFakeTimers()
})

afterEach(async () => {
  releaseStall?.()
  releaseStall = undefined
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
  if (originalDatabaseOverride === undefined) {
    delete process.env.OPENCODE_DB
  } else {
    process.env.OPENCODE_DB = originalDatabaseOverride
  }
})

// Why this file exists: the AI Vault's primary OpenCode source reaches these
// syscalls transitively, so the import-guard that pins direct `node:fs` use in
// the transcript modules never saw them (STA-4049).
describe('OpenCode database discovery on a stalled WSL data directory', () => {
  it('gates the data-directory listing instead of hanging the scan', async () => {
    mocks.readdir.mockImplementation(stalls)
    // Asserted because an empty list alone also matches a missing data dir; the
    // AI Vault's OpenCode source turns this callback into the scan issue.
    const onRefusal = vi.fn()

    expect(await settlesOnlyAtTheScanDeadline(listOpenCodeDatabases(onRefusal))).toEqual([])
    expect(onRefusal).toHaveBeenCalledWith(UNC_DATA_DIR, expect.any(WslTranscriptFsError))
  })

  it('gates an absolute UNC OPENCODE_DB probe instead of hanging the scan', async () => {
    process.env.OPENCODE_DB = UNC_DATABASE
    mocks.stat.mockImplementation(stalls)
    const onRefusal = vi.fn()

    expect(await settlesOnlyAtTheScanDeadline(listOpenCodeDatabases(onRefusal))).toEqual([])
    expect(mocks.readdir).not.toHaveBeenCalled()
    // Loose on the path: `isAbsolute` is host-flavoured, so a UNC override only
    // stays verbatim on Windows. The refusal reaching the caller is the contract.
    expect(onRefusal).toHaveBeenCalledWith(
      expect.stringContaining('opencode.db'),
      expect.any(WslTranscriptFsError)
    )
  })

  it('still lists databases when the distro answers', async () => {
    mocks.readdir.mockResolvedValue([dirent('opencode.db'), dirent('notes.txt')])

    await expect(listOpenCodeDatabases()).resolves.toEqual([join(UNC_DATA_DIR, 'opencode.db')])
    expect(mocks.readdir).toHaveBeenCalledWith(UNC_DATA_DIR, { withFileTypes: true })
  })
})

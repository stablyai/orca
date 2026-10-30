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
  resolveOpenCodeDataDirectory: mocks.resolveDataDirectory,
  resolveOpenCodeDatabasePath: () => UNC_DATABASE
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

// Release stalled tasks between cases: each holds the gate’s single scan slot until settlement.
let releaseStall: (() => void) | undefined

function stalls<T>(): Promise<T> {
  return new Promise<T>((resolve) => {
    releaseStall = () => resolve([] as T)
  })
}

// The child serializer reads every dirent kind flag.
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
  // Persistent route quarantine must not leak between cases.
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

// These transitive discovery syscalls escape direct filesystem import guards.
describe('OpenCode database discovery on a stalled WSL data directory', () => {
  it('gates the data-directory listing instead of hanging the scan', async () => {
    mocks.readdir.mockImplementation(stalls)
    // Empty results alone cannot distinguish missing data from gated refusal.
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
    // UNC paths remain verbatim only on Windows; assert refusal across hosts.
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

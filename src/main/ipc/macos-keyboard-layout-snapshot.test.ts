import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseKeyboardLayoutSnapshot } from './macos-keyboard-layout-snapshot'

const { execFileMock, existsSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  existsSyncMock: vi.fn()
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, execFile: execFileMock }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, existsSync: existsSyncMock }
})

describe('parseKeyboardLayoutSnapshot', () => {
  it('rejects malformed snapshots and skips malformed key entries', () => {
    expect(parseKeyboardLayoutSnapshot('not json')).toBeNull()
    expect(parseKeyboardLayoutSnapshot('{}')).toBeNull()
    expect(
      parseKeyboardLayoutSnapshot(
        JSON.stringify({ inputSourceId: 42, keyCharacters: { Digit2: 42 } })
      )
    ).toEqual({ inputSourceId: null, layoutSourceId: null, keyCharacters: {} })
  })
})

describe('readMacKeyboardLayoutSnapshot', () => {
  const originalPlatform = process.platform
  const helperStdout = (inputSourceId: string): string =>
    JSON.stringify({
      inputSourceId,
      layoutSourceId: 'layout.us',
      keyCharacters: { KeyA: { unmodified: 'a', shifted: 'A' } }
    })

  const loadSnapshotModule = () => import('./macos-keyboard-layout-snapshot')
  let snapshotModule: Awaited<ReturnType<typeof loadSnapshotModule>>

  beforeEach(async () => {
    vi.resetModules()
    execFileMock.mockReset()
    existsSyncMock.mockReset().mockReturnValue(true)
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    snapshotModule = await loadSnapshotModule()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('spawns the helper once and serves repeated reads from the cache', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: HelperCallback) =>
        callback(null, helperStdout('input.us'))
    )

    const first = await snapshotModule.readMacKeyboardLayoutSnapshot()
    const second = await snapshotModule.readMacKeyboardLayoutSnapshot()

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(first?.inputSourceId).toBe('input.us')
    expect(second).toEqual(first)
  })

  it('refetches through the helper after invalidation', async () => {
    execFileMock
      .mockImplementationOnce(
        (_file: string, _args: string[], _options: unknown, callback: HelperCallback) =>
          callback(null, helperStdout('input.us'))
      )
      .mockImplementationOnce(
        (_file: string, _args: string[], _options: unknown, callback: HelperCallback) =>
          callback(null, helperStdout('input.jp'))
      )

    await snapshotModule.readMacKeyboardLayoutSnapshot()
    snapshotModule.invalidateMacKeyboardLayoutSnapshot()
    const refreshed = await snapshotModule.readMacKeyboardLayoutSnapshot()

    expect(execFileMock).toHaveBeenCalledTimes(2)
    expect(refreshed?.inputSourceId).toBe('input.jp')
  })

  it('does not cache failed helper runs', async () => {
    execFileMock
      .mockImplementationOnce(
        (_file: string, _args: string[], _options: unknown, callback: HelperCallback) =>
          callback(new Error('helper failed'), '')
      )
      .mockImplementationOnce(
        (_file: string, _args: string[], _options: unknown, callback: HelperCallback) =>
          callback(null, helperStdout('input.us'))
      )

    expect(await snapshotModule.readMacKeyboardLayoutSnapshot()).toBeNull()
    expect((await snapshotModule.readMacKeyboardLayoutSnapshot())?.inputSourceId).toBe('input.us')
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('does not let a read that was in flight during invalidation repopulate the cache', async () => {
    let finishHelper!: HelperCallback
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: HelperCallback) => {
        finishHelper = callback
      }
    )

    const pending = snapshotModule.readMacKeyboardLayoutSnapshot()
    snapshotModule.invalidateMacKeyboardLayoutSnapshot()
    finishHelper(null, helperStdout('input.stale'))
    await pending

    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: HelperCallback) =>
        callback(null, helperStdout('input.fresh'))
    )
    const fresh = await snapshotModule.readMacKeyboardLayoutSnapshot()

    expect(execFileMock).toHaveBeenCalledTimes(2)
    expect(fresh?.inputSourceId).toBe('input.fresh')
  })

  it('merges concurrent reads into one helper run', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: HelperCallback) =>
        callback(null, helperStdout('input.us'))
    )

    const [first, second] = await Promise.all([
      snapshotModule.readMacKeyboardLayoutSnapshot(),
      snapshotModule.readMacKeyboardLayoutSnapshot()
    ])

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
  })
})

type HelperCallback = (error: Error | null, stdout: string) => void

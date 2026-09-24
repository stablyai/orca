import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnProcessMock } = vi.hoisted(() => ({ spawnProcessMock: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: spawnProcessMock }))

import { prewarmJcodeDaemon, resetJcodeDaemonPrewarmForTests } from './daemon-prewarm'

function stubChild() {
  return { unref: vi.fn(), on: vi.fn() }
}

/** Why the default: every case but the Windows one asserts POSIX behaviour, and the
 *  pre-warm is a no-op off POSIX — unpinned, they would all pass vacuously on a
 *  Windows runner. */
function prewarm(args: Parameters<typeof prewarmJcodeDaemon>[0]): boolean {
  return prewarmJcodeDaemon({ platform: 'darwin', ...args })
}

describe('jcode daemon pre-warm', () => {
  beforeEach(() => {
    resetJcodeDaemonPrewarmForTests()
    spawnProcessMock.mockReset()
    spawnProcessMock.mockReturnValue(stubChild())
  })
  afterEach(() => vi.restoreAllMocks())

  it('starts one detached daemon for a jcode pane', () => {
    expect(
      prewarm({
        launchAgent: 'jcode',
        runtimeDir: '/tmp/orca-jcode/abc',
        cwd: '/repo'
      })
    ).toBe(true)
    expect(spawnProcessMock).toHaveBeenCalledTimes(1)
    const spec = spawnProcessMock.mock.calls[0][0]
    expect(spec.args).toEqual(['--no-update', 'serve'])
    expect(spec.env.JCODE_RUNTIME_DIR).toBe('/tmp/orca-jcode/abc')
    expect(spec.detached).toBe(true)
    // Why stdio ignore: the daemon outlives this spawn, and an inherited pipe
    // would keep Orca attached to a process it does not own.
    expect(spec.stdio).toBe('ignore')
  })

  it('never spawns a daemon for a pane that is not jcode', () => {
    // Why: Orca stamps JCODE_RUNTIME_DIR on every local pane, so gating on the dir
    // alone would start a jcode server behind every plain shell the user opens.
    expect(prewarm({ launchAgent: 'claude', runtimeDir: '/tmp/orca-jcode/abc' })).toBe(false)
    expect(prewarm({ runtimeDir: '/tmp/orca-jcode/abc' })).toBe(false)
    expect(spawnProcessMock).not.toHaveBeenCalled()
  })

  it('warms each runtime dir at most once', () => {
    prewarm({ launchAgent: 'jcode', runtimeDir: '/tmp/orca-jcode/abc' })
    prewarm({ launchAgent: 'jcode', runtimeDir: '/tmp/orca-jcode/abc' })
    prewarm({ launchAgent: 'jcode', runtimeDir: '/tmp/orca-jcode/def' })
    expect(spawnProcessMock).toHaveBeenCalledTimes(2)
  })

  it('stays out of the way on Windows, which has no runtime dir', () => {
    expect(
      prewarm({
        launchAgent: 'jcode',
        runtimeDir: 'C:/tmp/orca-jcode/abc',
        platform: 'win32'
      })
    ).toBe(false)
    expect(spawnProcessMock).not.toHaveBeenCalled()
  })

  it('reports failure instead of throwing when the binary is missing', () => {
    spawnProcessMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    // Why fail-open: jcode's client starts its own server when none is listening,
    // so a failed pre-warm costs only the cold start Orca already had.
    expect(prewarm({ launchAgent: 'jcode', runtimeDir: '/tmp/orca-jcode/xyz' })).toBe(false)
  })

  it('retries a runtime dir whose daemon failed to start', () => {
    const child = stubChild()
    spawnProcessMock.mockReturnValue(child)
    prewarm({ launchAgent: 'jcode', runtimeDir: '/tmp/orca-jcode/retry' })
    const errorHandler = child.on.mock.calls.find(([event]) => event === 'error')?.[1]
    errorHandler?.(new Error('spawn failed'))
    prewarm({ launchAgent: 'jcode', runtimeDir: '/tmp/orca-jcode/retry' })
    expect(spawnProcessMock).toHaveBeenCalledTimes(2)
  })
})

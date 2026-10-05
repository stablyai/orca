import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeEnvironmentMock } = vi.hoisted(() => ({
  callRuntimeEnvironmentMock: vi.fn()
}))

vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))

import { clearRemoteTerminalTitleCache, getRemoteTerminalTitles } from './remote-terminal-titles'

const PATH = '/tmp/orca-user-data'
const ENV = 'env-1'

function listing(terminals: unknown[]) {
  return { ok: true, result: { terminals } }
}

describe('getRemoteTerminalTitles', () => {
  beforeEach(() => {
    callRuntimeEnvironmentMock.mockReset()
    clearRemoteTerminalTitleCache()
  })

  it('maps pty id to title', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue(
      listing([
        { ptyId: 'pty-1', title: 'Terminal 1' },
        { ptyId: 'pty-2', title: '  build watch  ' }
      ])
    )
    const titles = await getRemoteTerminalTitles(PATH, ENV)
    expect(titles.get('pty-1')).toBe('Terminal 1')
    expect(titles.get('pty-2')).toBe('build watch')
  })

  it('skips rows with no pty id or no title', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue(
      listing([
        { ptyId: null, title: 'orphan' },
        { ptyId: 'pty-2', title: null },
        { ptyId: 'pty-3', title: '   ' },
        { ptyId: 'pty-4', title: 'kept' }
      ])
    )
    const titles = await getRemoteTerminalTitles(PATH, ENV)
    expect([...titles.keys()]).toEqual(['pty-4'])
  })

  it('asks the host without layouts or liveness probes', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue(listing([]))
    await getRemoteTerminalTitles(PATH, ENV)
    const [, environmentId, method, params, timeoutMs] = callRuntimeEnvironmentMock.mock.calls[0]
    expect(environmentId).toBe(ENV)
    expect(method).toBe('terminal.list')
    expect(params).toMatchObject({ includeVisualLayouts: false, requireFreshPtyLiveness: false })
    expect(timeoutMs).toBeLessThan(10_000)
  })

  // Why: the panel polls every 2s; titles change far more slowly than usage does.
  it('serves later polls from cache', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue(listing([{ ptyId: 'pty-1', title: 'a' }]))
    await getRemoteTerminalTitles(PATH, ENV, 1_000)
    await getRemoteTerminalTitles(PATH, ENV, 3_000)
    await getRemoteTerminalTitles(PATH, ENV, 5_000)
    expect(callRuntimeEnvironmentMock).toHaveBeenCalledTimes(1)
  })

  it('refetches once the cache expires', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue(listing([{ ptyId: 'pty-1', title: 'a' }]))
    await getRemoteTerminalTitles(PATH, ENV, 1_000)
    await getRemoteTerminalTitles(PATH, ENV, 1_000 + 60_000)
    expect(callRuntimeEnvironmentMock).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent lookups for one host', async () => {
    let resolve: (v: unknown) => void = () => {}
    callRuntimeEnvironmentMock.mockReturnValue(new Promise((r) => (resolve = r)))
    const first = getRemoteTerminalTitles(PATH, ENV)
    const second = getRemoteTerminalTitles(PATH, ENV)
    resolve(listing([{ ptyId: 'pty-1', title: 'a' }]))
    await Promise.all([first, second])
    expect(callRuntimeEnvironmentMock).toHaveBeenCalledTimes(1)
  })

  it('keeps hosts separate', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue(listing([{ ptyId: 'pty-1', title: 'a' }]))
    await getRemoteTerminalTitles(PATH, 'env-a')
    await getRemoteTerminalTitles(PATH, 'env-b')
    expect(callRuntimeEnvironmentMock).toHaveBeenCalledTimes(2)
  })

  // Why: titles are a nicety. A host that cannot answer must cost the labels only.
  it('returns nothing when the host reports a failure', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue({
      ok: false,
      error: { code: 'unknown_method', message: 'no such method' }
    })
    await expect(getRemoteTerminalTitles(PATH, ENV)).resolves.toEqual(new Map())
  })

  it('returns nothing when the call throws', async () => {
    callRuntimeEnvironmentMock.mockRejectedValue(new Error('offline'))
    await expect(getRemoteTerminalTitles(PATH, ENV)).resolves.toEqual(new Map())
  })

  it('returns nothing when the reply is not a listing', async () => {
    callRuntimeEnvironmentMock.mockResolvedValue({ ok: true, result: { nope: true } })
    await expect(getRemoteTerminalTitles(PATH, ENV)).resolves.toEqual(new Map())
  })

  // Why: otherwise a host that cannot answer is re-asked on every 2s poll.
  it('caches a failure so it is not retried on every poll', async () => {
    callRuntimeEnvironmentMock.mockRejectedValue(new Error('offline'))
    await getRemoteTerminalTitles(PATH, ENV, 1_000)
    await getRemoteTerminalTitles(PATH, ENV, 3_000)
    expect(callRuntimeEnvironmentMock).toHaveBeenCalledTimes(1)
  })
})

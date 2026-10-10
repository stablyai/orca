import { describe, expect, it, vi } from 'vitest'

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle } }))

import { registerUsageProviderHandlers } from './usage-provider-handlers'

describe('usage provider IPC handlers', () => {
  it('registers every provider route and forwards query arguments', async () => {
    const createUsage = () => ({
      whenLoaded: vi.fn(() => Promise.resolve()),
      getScanState: vi.fn(),
      setEnabled: vi.fn(),
      refresh: vi.fn(),
      getSnapshot: vi.fn(),
      getSummary: vi.fn(),
      getDaily: vi.fn(),
      getBreakdown: vi.fn(),
      getRecentSessions: vi.fn()
    })
    const claudeUsage = createUsage()
    const codexUsage = createUsage()
    const openCodeUsage = createUsage()
    const museUsage = createUsage()
    registerUsageProviderHandlers({
      claudeUsage: claudeUsage as never,
      codexUsage: codexUsage as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every method the registrar calls on a usage store.
      museUsage: museUsage as never,
      openCodeUsage: openCodeUsage as never
    })

    const prefixes = ['claudeUsage', 'codexUsage', 'openCodeUsage', 'museUsage']
    const suffixes = Object.keys(claudeUsage).filter((key) => key !== 'whenLoaded')
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual(
      prefixes.flatMap((prefix) => suffixes.map((suffix) => `${prefix}:${suffix}`))
    )

    const call = (prefix: string, suffix: string, args?: unknown): unknown => {
      const handler = handle.mock.calls.find(
        ([channel]) => channel === `${prefix}:${suffix}`
      )?.[1] as ((event: unknown, args?: unknown) => unknown) | undefined
      return handler?.({}, args)
    }
    await call('claudeUsage', 'getScanState')
    await call('codexUsage', 'getScanState')
    await call('openCodeUsage', 'getScanState')
    await call('museUsage', 'getScanState')
    await call('claudeUsage', 'setEnabled', { enabled: true })
    await call('claudeUsage', 'refresh')
    await call('claudeUsage', 'refresh', { force: true })
    await call('claudeUsage', 'getSnapshot', { scope: 'orca', range: '30d', limit: 7 })
    await call('claudeUsage', 'getSummary', { scope: 'all', range: '7d' })
    await call('claudeUsage', 'getDaily', { scope: 'orca', range: '90d' })
    await call('claudeUsage', 'getBreakdown', { scope: 'all', range: 'all', kind: 'model' })
    await call('claudeUsage', 'getRecentSessions', { scope: 'orca', range: '30d', limit: 4 })

    expect(claudeUsage.getScanState).toHaveBeenCalledWith()
    expect(codexUsage.getScanState).toHaveBeenCalledWith()
    expect(openCodeUsage.getScanState).toHaveBeenCalledWith()
    expect(museUsage.getScanState).toHaveBeenCalledWith()
    expect(claudeUsage.setEnabled).toHaveBeenCalledWith(true)
    expect(claudeUsage.refresh.mock.calls).toEqual([[false], [true]])
    expect(claudeUsage.getSnapshot).toHaveBeenCalledWith('orca', '30d', 7)
    expect(claudeUsage.getSummary).toHaveBeenCalledWith('all', '7d')
    expect(claudeUsage.getDaily).toHaveBeenCalledWith('orca', '90d')
    expect(claudeUsage.getBreakdown).toHaveBeenCalledWith('all', 'all', 'model')
    expect(claudeUsage.getRecentSessions).toHaveBeenCalledWith('orca', '30d', 4)
  })

  it('answers the synchronous reads only once persisted state has loaded', async () => {
    handle.mockClear()
    let finishLoad = () => {}
    const loaded = new Promise<void>((resolve) => {
      finishLoad = resolve
    })
    const createUsage = () => ({
      whenLoaded: () => loaded,
      getScanState: vi.fn(() => 'scan-state'),
      setEnabled: vi.fn(),
      refresh: vi.fn(),
      getSnapshot: vi.fn(() => 'snapshot'),
      getSummary: vi.fn(),
      getDaily: vi.fn(),
      getBreakdown: vi.fn(),
      getRecentSessions: vi.fn()
    })
    const claudeUsage = createUsage()
    const codexUsage = createUsage()
    const openCodeUsage = createUsage()
    const museUsage = createUsage()
    registerUsageProviderHandlers({
      claudeUsage: claudeUsage as never,
      codexUsage: codexUsage as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every method the registrar calls on a usage store.
      museUsage: museUsage as never,
      openCodeUsage: openCodeUsage as never
    })
    const handler = (suffix: string): ((event: unknown, args?: unknown) => Promise<unknown>) =>
      handle.mock.calls.find(([channel]) => channel === `claudeUsage:${suffix}`)?.[1]

    const scanState = handler('getScanState')({})
    const snapshot = handler('getSnapshot')({}, { scope: 'all', range: 'all' })
    await Promise.resolve()
    expect(claudeUsage.getScanState).not.toHaveBeenCalled()
    expect(claudeUsage.getSnapshot).not.toHaveBeenCalled()

    finishLoad()
    await expect(scanState).resolves.toBe('scan-state')
    await expect(snapshot).resolves.toBe('snapshot')
  })
})

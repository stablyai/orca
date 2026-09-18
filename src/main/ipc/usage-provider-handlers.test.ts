import { describe, expect, it, vi } from 'vitest'

const { handle, isTrustedUIRenderer } = vi.hoisted(() => ({
  handle: vi.fn(),
  isTrustedUIRenderer: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle } }))
vi.mock('./ui', () => ({ isTrustedUIRenderer }))

import { registerUsageProviderHandlers } from './usage-provider-handlers'

describe('usage provider IPC handlers', () => {
  it('registers every provider route and forwards query arguments', () => {
    isTrustedUIRenderer.mockReturnValue(true)
    const createUsage = () => ({
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
    const devinUsage = createUsage()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: createUsage supplies every method the registered routes forward to; the real stores carry unrelated lifecycle surface this fixture does not need.
    const usage = { claudeUsage, codexUsage, openCodeUsage, devinUsage } as never
    registerUsageProviderHandlers(usage)

    const prefixes = ['claudeUsage', 'codexUsage', 'openCodeUsage', 'devinUsage']
    const suffixes = Object.keys(claudeUsage)
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual(
      prefixes.flatMap((prefix) => suffixes.map((suffix) => `${prefix}:${suffix}`))
    )

    const call = (prefix: string, suffix: string, args?: unknown): unknown => {
      const handler = handle.mock.calls.find(
        ([channel]) => channel === `${prefix}:${suffix}`
      )?.[1] as ((event: unknown, args?: unknown) => unknown) | undefined
      return handler?.({ sender: 'renderer' }, args)
    }
    call('claudeUsage', 'getScanState')
    call('codexUsage', 'getScanState')
    call('openCodeUsage', 'getScanState')
    call('devinUsage', 'getScanState')
    call('claudeUsage', 'setEnabled', { enabled: true })
    call('claudeUsage', 'refresh')
    call('claudeUsage', 'refresh', { force: true })
    call('claudeUsage', 'getSnapshot', { scope: 'orca', range: '30d', limit: 7 })
    call('claudeUsage', 'getSummary', { scope: 'all', range: '7d' })
    call('claudeUsage', 'getDaily', { scope: 'orca', range: '90d' })
    call('claudeUsage', 'getBreakdown', { scope: 'all', range: 'all', kind: 'model' })
    call('claudeUsage', 'getRecentSessions', { scope: 'orca', range: '30d', limit: 4 })

    expect(claudeUsage.getScanState).toHaveBeenCalledWith()
    expect(codexUsage.getScanState).toHaveBeenCalledWith()
    expect(openCodeUsage.getScanState).toHaveBeenCalledWith()
    expect(devinUsage.getScanState).toHaveBeenCalledWith()
    expect(claudeUsage.setEnabled).toHaveBeenCalledWith(true)
    expect(claudeUsage.refresh.mock.calls).toEqual([[false], [true]])
    expect(claudeUsage.getSnapshot).toHaveBeenCalledWith('orca', '30d', 7)
    expect(claudeUsage.getSummary).toHaveBeenCalledWith('all', '7d')
    expect(claudeUsage.getDaily).toHaveBeenCalledWith('orca', '90d')
    expect(claudeUsage.getBreakdown).toHaveBeenCalledWith('all', 'all', 'model')
    expect(claudeUsage.getRecentSessions).toHaveBeenCalledWith('orca', '30d', 4)
  })

  it('rejects untrusted senders and malformed payloads before reaching the store', () => {
    handle.mockClear()
    const devinUsage = {
      getScanState: vi.fn(),
      setEnabled: vi.fn(),
      refresh: vi.fn(),
      getSnapshot: vi.fn(),
      getSummary: vi.fn(),
      getDaily: vi.fn(),
      getBreakdown: vi.fn(),
      getRecentSessions: vi.fn()
    }
    const stub = { getScanState: vi.fn(), setEnabled: vi.fn(), refresh: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same fixture rationale as the registration test above.
    const usage = {
      claudeUsage: stub,
      codexUsage: stub,
      openCodeUsage: stub,
      devinUsage
    } as never
    registerUsageProviderHandlers(usage)

    const call = (suffix: string, args: unknown, trusted: boolean): unknown => {
      isTrustedUIRenderer.mockReturnValue(trusted)
      const handler = handle.mock.calls.find(([channel]) => channel === `devinUsage:${suffix}`)?.[1]
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ipcMain.handle registers (event, args) handlers; the lookup above returns one of them.
      const invoke = handler as ((event: unknown, args?: unknown) => unknown) | undefined
      return invoke?.({ sender: 'renderer' }, args)
    }

    // Untrusted renderer: nothing reaches the store.
    expect(call('getSummary', { scope: 'all', range: '7d' }, false)).toBeNull()
    expect(call('setEnabled', { enabled: true }, false)).toBeNull()
    expect(call('refresh', { force: true }, false)).toBeNull()
    expect(devinUsage.getSummary).not.toHaveBeenCalled()
    expect(devinUsage.setEnabled).not.toHaveBeenCalled()
    expect(devinUsage.refresh).not.toHaveBeenCalled()

    // Malformed payloads: rejected at the boundary, store untouched.
    expect(call('getSummary', { scope: 'bogus', range: '7d' }, true)).toBeNull()
    expect(call('getSummary', { range: '7d' }, true)).toBeNull()
    expect(call('getDaily', { scope: 'all', range: 'next week' }, true)).toBeNull()
    expect(call('getBreakdown', { scope: 'all', range: '7d', kind: 'hour' }, true)).toBeNull()
    expect(call('getSnapshot', null, true)).toBeNull()
    expect(call('setEnabled', { enabled: 'yes' }, true)).toBeNull()
    expect(call('setEnabled', {}, true)).toBeNull()
    expect(devinUsage.getSummary).not.toHaveBeenCalled()
    expect(devinUsage.getDaily).not.toHaveBeenCalled()
    expect(devinUsage.getBreakdown).not.toHaveBeenCalled()
    expect(devinUsage.getSnapshot).not.toHaveBeenCalled()
    expect(devinUsage.setEnabled).not.toHaveBeenCalled()

    // limit must be a positive finite number; anything else falls back to
    // the store default rather than propagating junk.
    call('getRecentSessions', { scope: 'all', range: '7d', limit: 'many' }, true)
    expect(devinUsage.getRecentSessions).toHaveBeenCalledWith('all', '7d', undefined)
  })
})

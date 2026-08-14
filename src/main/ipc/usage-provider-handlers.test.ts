import { describe, expect, it, vi } from 'vitest'

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle } }))

import { registerUsageProviderHandlers } from './usage-provider-handlers'

describe('usage provider IPC handlers', () => {
  it('registers every provider route and forwards query arguments', () => {
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
    registerUsageProviderHandlers({
      claudeUsage: claudeUsage as never,
      codexUsage: codexUsage as never,
      openCodeUsage: openCodeUsage as never
    })

    const prefixes = ['claudeUsage', 'codexUsage', 'openCodeUsage']
    const suffixes = Object.keys(claudeUsage)
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual(
      prefixes.flatMap((prefix) => suffixes.map((suffix) => `${prefix}:${suffix}`))
    )

    const call = (prefix: string, suffix: string, args?: unknown): unknown => {
      const handler = handle.mock.calls.find(
        ([channel]) => channel === `${prefix}:${suffix}`
      )?.[1] as ((event: unknown, args?: unknown) => unknown) | undefined
      return handler?.({}, args)
    }
    call('claudeUsage', 'getScanState')
    call('codexUsage', 'getScanState')
    call('openCodeUsage', 'getScanState')
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
    expect(claudeUsage.setEnabled).toHaveBeenCalledWith(true)
    expect(claudeUsage.refresh.mock.calls).toEqual([[false], [true]])
    expect(claudeUsage.getSnapshot).toHaveBeenCalledWith('orca', '30d', 7)
    expect(claudeUsage.getSummary).toHaveBeenCalledWith('all', '7d')
    expect(claudeUsage.getDaily).toHaveBeenCalledWith('orca', '90d')
    expect(claudeUsage.getBreakdown).toHaveBeenCalledWith('all', 'all', 'model')
    expect(claudeUsage.getRecentSessions).toHaveBeenCalledWith('orca', '30d', 4)
  })
})

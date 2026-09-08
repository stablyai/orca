import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { MobileWebTerminalMetadataAction } from '../../../src/mobile-web/src/mobile-web-host-terminal-actions'
import { webHostSessionTerminalOperations } from './web-host-session-terminal-operations'

function fixture() {
  let resolve!: (action: MobileWebTerminalMetadataAction) => void
  let reject!: (error: Error) => void
  const prepared = new Promise<MobileWebTerminalMetadataAction>((yes, no) => {
    resolve = yes
    reject = no
  })
  const prepareTerminalActions = vi.fn(() => prepared)
  const unsubscribe = vi.fn()
  const terminalSubscribe = vi.fn(() => ({
    streamId: 'S'.repeat(22),
    ready: Promise.resolve(),
    unsubscribe
  }))
  const terminalRequest = vi.fn().mockResolvedValue(null)
  const client = {
    prepareTerminalActions,
    terminalSubscribe,
    terminalRequest
  } as unknown as MobileWebBridgeClient
  const operations = webHostSessionTerminalOperations(client)
  const onError = vi.fn()
  const subscribe = () =>
    operations.subscribe(
      {
        workspaceId: 'workspace',
        terminalId: 'tab',
        clientId: null,
        viewport: null,
        visible: true,
        capabilities: { terminalBinaryStream: 1 }
      },
      vi.fn(),
      onError
    )
  const run = vi.fn().mockResolvedValue(null)
  return {
    resolve,
    reject,
    prepareTerminalActions,
    unsubscribe,
    terminalSubscribe,
    terminalRequest,
    operations,
    onError,
    subscribe,
    run
  }
}

describe('hosted terminal metadata lifecycle', () => {
  it('renames an inactive tab through a fresh host binding without opening a terminal stream', async () => {
    const f = fixture()
    f.resolve(f.run)
    expect(await f.operations.rename('tab', 'Build', 'workspace')).toBe(true)
    expect(f.prepareTerminalActions).toHaveBeenCalledWith(
      'workspace',
      'tab',
      expect.any(AbortSignal)
    )
    expect(f.run).toHaveBeenCalledExactlyOnceWith({ operation: 'rename', title: 'Build' })
    expect(f.terminalSubscribe).not.toHaveBeenCalled()
    f.run.mockRejectedValueOnce(new Error('lost acknowledgement'))
    expect(await f.operations.rename('tab', 'Other', 'workspace')).toBe(false)
    expect(f.run).toHaveBeenCalledTimes(2)
  })
  it('binds terminal identity before opening its stream and sends all metadata through that resource', async () => {
    const f = fixture()
    const cleanup = f.subscribe()
    expect(f.terminalSubscribe).not.toHaveBeenCalled()
    expect(await f.operations.clear('tab')).toBe(false)
    f.resolve(f.run)
    await vi.waitFor(() => expect(f.terminalSubscribe).toHaveBeenCalledOnce())
    expect(await f.operations.setDisplayMode('tab', 'auto', { cols: 90, rows: 30 }, null)).toBe(
      true
    )
    expect(await f.operations.rename('tab', 'Build', 'workspace')).toBe(true)
    expect(await f.operations.clear('tab')).toBe(true)
    expect(f.run.mock.calls.map(([request]) => request.operation)).toEqual([
      'displayMode',
      'rename',
      'clear'
    ])
    expect(f.terminalRequest).not.toHaveBeenCalled()
    const signal = (f.prepareTerminalActions.mock.calls[0] as unknown[])[2] as AbortSignal
    cleanup()
    expect(signal.aborted).toBe(true)
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(await f.operations.clear('tab')).toBe(false)
    expect(f.run).toHaveBeenCalledTimes(3)
  })
  it('retiring a pending binding prevents the eventual stream from opening', async () => {
    const f = fixture()
    const cleanup = f.subscribe()
    cleanup()
    f.resolve(f.run)
    await Promise.resolve()
    expect(f.terminalSubscribe).not.toHaveBeenCalled()
    expect(f.onError).not.toHaveBeenCalled()
  })
  it('reports binding failures and action ambiguity without opening a fallback stream or repeating the action', async () => {
    const failed = fixture()
    failed.subscribe()
    failed.reject(new Error('connection lost'))
    await vi.waitFor(() => expect(failed.onError).toHaveBeenCalledOnce())
    expect(failed.terminalSubscribe).not.toHaveBeenCalled()
    const f = fixture()
    f.subscribe()
    f.resolve(f.run)
    await vi.waitFor(() => expect(f.terminalSubscribe).toHaveBeenCalledOnce())
    f.run.mockRejectedValueOnce(new Error('lost acknowledgement'))
    expect(await f.operations.clear('tab')).toBe(false)
    expect(f.onError).toHaveBeenCalledOnce()
    expect(f.run).toHaveBeenCalledOnce()
    expect(f.terminalRequest).not.toHaveBeenCalled()
  })
})

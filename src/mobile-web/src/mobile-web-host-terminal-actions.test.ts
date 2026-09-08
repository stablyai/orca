import { describe, expect, it, vi } from 'vitest'
import { mobileWebHostTerminalActions } from './mobile-web-host-terminal-actions'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

const METHOD = 'mobileWeb.terminal.action'
function fixture() {
  const request = vi.fn(async (..._args: unknown[]) => ({ applied: true, future: 1 }))
  const requests = { supports: () => true, request } as unknown as MobileWebOneShotRequestClient
  const signal = new AbortController().signal
  return { requests, request, signal }
}
describe('page-owned terminal metadata forwarding', () => {
  it('sends each metadata action against the tab id, keeping stream ids out of host payloads', async () => {
    const f = fixture()
    const run = mobileWebHostTerminalActions(f.requests, 'workspace', 'tab', f.signal)
    for (const request of [
      {
        operation: 'displayMode' as const,
        mode: 'auto' as const,
        viewport: { cols: 90, rows: 30 }
      },
      { operation: 'rename' as const, title: 'Build' },
      { operation: 'clear' as const }
    ]) {
      await expect(run(request)).resolves.toBeNull()
    }
    expect(f.request.mock.calls.map((call) => call[2])).toEqual(
      [
        {
          method: 'terminal.setDisplayMode',
          fields: { mode: 'auto', viewport: { cols: 90, rows: 30 } }
        },
        { method: 'terminal.rename', fields: { title: 'Build' } },
        { method: 'terminal.clearBuffer', fields: {} }
      ].map((params) => ({
        method: METHOD,
        workspaceId: 'workspace',
        params: { tabId: 'tab', ...params, timeoutMs: 15_000 }
      }))
    )
    expect(
      f.request.mock.calls.every(
        (call) =>
          (call as unknown[]).at(-1) &&
          ((call as unknown[]).at(-1) as { signal: AbortSignal }).signal === f.signal
      )
    ).toBe(true)
  })

  it('asks the host nothing before the first action', () => {
    const f = fixture()
    mobileWebHostTerminalActions(f.requests, 'workspace', 'tab', f.signal)
    expect(f.request).not.toHaveBeenCalled()
  })

  it.each(['timeout', 'unsupported_capability', 'host_error'] as const)(
    'does not retry after action returns %s',
    async (code) => {
      const f = fixture()
      const run = mobileWebHostTerminalActions(f.requests, 'w', 't', f.signal)
      f.request.mockRejectedValueOnce(new MobileWebBridgeClientError(code, true))
      await expect(run({ operation: 'clear' })).rejects.toMatchObject({ code })
      expect(f.request).toHaveBeenCalledOnce()
    }
  )

  it('rejects an acknowledgement that does not report the action as applied', async () => {
    const f = fixture()
    const run = mobileWebHostTerminalActions(f.requests, 'w', 't', f.signal)
    f.request.mockResolvedValueOnce({ applied: false, future: 1 })
    await expect(run({ operation: 'clear' })).rejects.toMatchObject({ code: 'invalid_message' })
  })
})

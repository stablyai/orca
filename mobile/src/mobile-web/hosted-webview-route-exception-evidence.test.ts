import { beforeEach, describe, expect, it, vi } from 'vitest'

const { evaluate } = vi.hoisted(() => ({ evaluate: vi.fn() }))

vi.mock('../../scripts/hosted-webview-cdp-session.mjs', () => ({
  evaluateHostedDocumentWithRetry: evaluate
}))

import {
  installHostedWebViewRouteExceptionCapture,
  readHostedWebViewRouteExceptionEvidence
} from '../../scripts/hosted-webview-route-exception-evidence.mjs'

describe('hosted WebView route exception evidence', () => {
  beforeEach(() => {
    evaluate.mockReset()
  })

  it('installs a bounded error-only capture in the hosted document', async () => {
    evaluate.mockResolvedValue('installed')

    const WebSocketCtor = class {}
    await installHostedWebViewRouteExceptionCapture({ targetId: 'hosted' }, WebSocketCtor)

    expect(evaluate).toHaveBeenCalledWith(
      { targetId: 'hosted' },
      expect.stringContaining("append('unhandled-rejection'"),
      WebSocketCtor
    )
    expect(evaluate.mock.calls[0][1]).toContain('entries.length > 24')
    expect(evaluate.mock.calls[0][1]).toContain('.slice(0, 4096)')
  })

  it('returns only bounded exception evidence entries', async () => {
    evaluate.mockResolvedValue(
      JSON.stringify([
        { kind: 'console-error', text: 'TypeError: failed' },
        { kind: 'other', text: 'ignored' },
        { kind: 'window-error', text: 'x'.repeat(4_097) }
      ])
    )

    const WebSocketCtor = class {}
    await expect(
      readHostedWebViewRouteExceptionEvidence({ targetId: 'hosted' }, WebSocketCtor)
    ).resolves.toEqual([{ kind: 'console-error', text: 'TypeError: failed' }])
  })
})

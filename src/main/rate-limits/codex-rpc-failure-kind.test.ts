import { describe, expect, it } from 'vitest'
import { classifyCodexRpcErrorFailureKind } from './codex-rpc-failure-kind'

// Captured from codex-cli 0.162.0 `app-server` with HTTPS_PROXY=http://127.0.0.1:9 (nothing listening).
const CAPTURED_DEAD_PROXY_ERROR =
  'failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)'

describe('classifyCodexRpcErrorFailureKind', () => {
  it('classifies the captured unreachable-proxy error as a network failure', () => {
    expect(classifyCodexRpcErrorFailureKind(CAPTURED_DEAD_PROXY_ERROR)).toBe('network')
  })

  it('classifies a body transport error as a network failure', () => {
    expect(
      classifyCodexRpcErrorFailureKind(
        'failed to fetch codex rate limits: request or response body error'
      )
    ).toBe('network')
  })

  it('leaves HTTP status and auth failures unclassified', () => {
    for (const message of [
      'failed to fetch codex rate limits: unexpected status 429 Too Many Requests',
      'failed to fetch codex rate limits: no snapshots returned',
      'chatgpt authentication required to read rate limits'
    ]) {
      expect(classifyCodexRpcErrorFailureKind(message)).toBeUndefined()
    }
  })
})

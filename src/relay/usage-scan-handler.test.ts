import { describe, expect, it, vi } from 'vitest'
import {
  SSH_USAGE_SCAN_CLAUDE_METHOD,
  SSH_USAGE_SCAN_FIELD_MAX_LENGTH,
  SSH_USAGE_SCAN_PAGES_MAX,
  normalizeSshClaudeUsageScanParams
} from '../main/claude-usage/ssh-usage-relay-contract'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { UsageScanHandler } from './usage-scan-handler'

type RequestHandler = (params: Record<string, unknown>, context: RequestContext) => Promise<unknown>

function createMockDispatcher(): { value: RelayDispatcher; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only calls onRequest.
  const value = {
    onRequest(method: string, handler: RequestHandler) {
      handlers.set(method, handler)
    }
  } as unknown as RelayDispatcher
  return { value, handlers }
}

const worktree = { repoId: 'r', worktreeId: 'r::/srv/r', path: '/srv/r', displayName: 'R' }

describe('UsageScanHandler', () => {
  it('forwards normalized params and the abort signal to the sidecar', async () => {
    const dispatcher = createMockDispatcher()
    const scanClaudeUsage = vi.fn(async () => ({
      scanId: 's',
      pageIndex: 0,
      pageCount: 1,
      sessions: [],
      dailyAggregates: []
    }))
    new UsageScanHandler(dispatcher.value, { scanClaudeUsage })
    const controller = new AbortController()

    await dispatcher.handlers.get(SSH_USAGE_SCAN_CLAUDE_METHOD)?.(
      { worktrees: [worktree, { repoId: 'missing-fields' }] },
      { clientId: 1, isStale: () => false, signal: controller.signal }
    )

    expect(scanClaudeUsage).toHaveBeenCalledWith({ worktrees: [worktree] }, controller.signal)
  })

  it('leaves the method unregistered without a sidecar so old-relay fallback applies', () => {
    const dispatcher = createMockDispatcher()
    new UsageScanHandler(dispatcher.value, undefined)

    expect(dispatcher.handlers.has(SSH_USAGE_SCAN_CLAUDE_METHOD)).toBe(false)
  })
})

describe('normalizeSshClaudeUsageScanParams', () => {
  it('drops malformed and oversized worktrees', () => {
    const oversized = 'x'.repeat(SSH_USAGE_SCAN_FIELD_MAX_LENGTH + 1)

    expect(
      normalizeSshClaudeUsageScanParams({
        worktrees: [
          worktree,
          null,
          { ...worktree, path: '' },
          { ...worktree, displayName: oversized },
          { ...worktree, repoId: 7 }
        ]
      })
    ).toEqual({ worktrees: [worktree] })
    expect(normalizeSshClaudeUsageScanParams({ worktrees: 'nope' })).toEqual({ worktrees: [] })
  })

  it('accepts only follow-up page requests within bounds', () => {
    const page = (index: unknown) =>
      normalizeSshClaudeUsageScanParams({ worktrees: [], page: { scanId: 's', index } }).page

    expect(page(1)).toEqual({ scanId: 's', index: 1 })
    // Page 0 is the scan itself, so it must not be served from a stale result.
    expect(page(0)).toBeUndefined()
    expect(page(1.5)).toBeUndefined()
    expect(page(SSH_USAGE_SCAN_PAGES_MAX)).toBeUndefined()
  })
})

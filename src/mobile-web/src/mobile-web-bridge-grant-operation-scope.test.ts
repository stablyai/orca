import { describe, expect, it } from 'vitest'
import type {
  MobileWebBridgePageMessage,
  MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'

type Grants = Extract<MobileWebBridgeShellMessage, { type: 'init' }>['grants']

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}
const WORKSPACE_ID = 'repo-1::/workspace'
const RELATIVE_PATH = 'src/index.ts'

const LIMITS = {
  maxRequestBytes: 4096,
  maxResponseBytes: 64 * 1024,
  maxConcurrent: 2,
  rateCapacity: 8,
  rateRefillPerSecond: 2
}

describe('mobile web bridge grant operation scope', () => {
  it('keeps a granted operation from authorizing a sibling operation of the same capability', async () => {
    const harness = createHarness([
      { capability: 'file', operation: 'markdownDraftRead', limits: LIMITS }
    ])
    const target = { workspaceId: WORKSPACE_ID, tabId: 'tab-1', relativePath: RELATIVE_PATH }

    void harness.client.markdown.loadDraft(target)
    expect(harness.messages).toMatchObject([{ capability: 'file', operation: 'markdownDraftRead' }])

    const save = harness.client.markdown
      .saveDraft({ ...target, draft: { content: 'after', baseVersion: 'v1' } })
      .then(
        () => 'resolved',
        (error: unknown) => error
      )
    expect(harness.messages).toHaveLength(1)
    // The refusal must be the grant lookup, not a limit the sibling grant happens to fail.
    await expect(save).resolves.toMatchObject({
      code: 'unsupported_capability',
      retryable: false
    })
  })

  it('keeps per-capability request limits apart across capabilities', async () => {
    const harness = createHarness([
      {
        capability: 'workspace',
        operation: 'snapshot',
        limits: { ...LIMITS, maxRequestBytes: 8 }
      },
      { capability: 'account', operation: 'resetCreditCapability', limits: LIMITS }
    ])

    const oversize = harness.client.workspaceSnapshot({ limit: 10 }).then(
      () => 'resolved',
      (error: unknown) => error
    )
    expect(harness.messages).toHaveLength(0)
    await expect(oversize).resolves.toMatchObject({ code: 'too_large', retryable: false })

    void harness.client.account.resetCreditCapability()
    expect(harness.messages).toMatchObject([
      { capability: 'account', operation: 'resetCreditCapability' }
    ])
  })
})

function createHarness(grants: Grants) {
  const messages: MobileWebBridgePageMessage[] = []
  let nextId = 0
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants,
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => {
      nextId += 1
      return String(nextId).padStart(22, 'R')
    }
  })
  return { client, messages }
}

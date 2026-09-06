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
    const harness = createHarness([{ capability: 'file', operation: 'read', limits: LIMITS }])

    void harness.client.fileRead({ workspaceId: WORKSPACE_ID, relativePath: RELATIVE_PATH })
    expect(harness.messages).toMatchObject([{ capability: 'file', operation: 'read' }])

    const write = harness.client
      .fileWrite({
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        expectedRevision: 'a'.repeat(64),
        contentBase64: btoa('after')
      })
      .then(
        () => 'resolved',
        (error: unknown) => error
      )
    expect(harness.messages).toHaveLength(1)
    // The refusal must be the grant lookup, not a limit the sibling grant happens to fail.
    await expect(write).resolves.toMatchObject({
      code: 'unsupported_capability',
      retryable: false
    })
  })

  it('keeps per-capability request limits apart when two capabilities share an operation name', async () => {
    const harness = createHarness([
      {
        capability: 'workspace',
        operation: 'snapshot',
        limits: { ...LIMITS, maxRequestBytes: 8 }
      },
      { capability: 'session', operation: 'snapshot', limits: LIMITS }
    ])

    const oversize = harness.client.workspaceSnapshot({ limit: 10 }).then(
      () => 'resolved',
      (error: unknown) => error
    )
    expect(harness.messages).toHaveLength(0)
    await expect(oversize).resolves.toMatchObject({ code: 'too_large', retryable: false })

    void harness.client.sessionSnapshot({ workspaceId: WORKSPACE_ID })
    expect(harness.messages).toMatchObject([{ capability: 'session', operation: 'snapshot' }])
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

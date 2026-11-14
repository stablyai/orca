import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_RPC_ENVELOPE_GRANT } from '../protocol/bridge-frame-fields'

import { INIT, createPageClient } from '../test-support/bridge-page-client-test-harness'

const ENVELOPE = { executionHost: 'runtime:a', nested: { list: [1, 'two', null, true] } }

function grantedPage() {
  const page = createPageClient()
  page.deliver({
    ...INIT,
    grants: { ...INIT.grants, native: [BRIDGE_RPC_ENVELOPE_GRANT] }
  })
  return page
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('bridge rpc envelope: page side', () => {
  it('posts no options when the only option was the envelope, and keeps an empty bag', () => {
    const page = grantedPage()
    void page.client.sendRequest('worktree.ps', { a: 1 }, { envelope: {} })
    void page.client.sendRequest('worktree.ps', { a: 1 }, { envelope: ENVELOPE })
    void page.client.sendRequest('worktree.ps', { a: 1 }, {})
    const [, emptyOnly, envelopeOnly, emptyBag] = page.frames()
    expect(emptyOnly).not.toHaveProperty('options')
    expect(emptyOnly).not.toHaveProperty('envelope')
    expect(envelopeOnly).not.toHaveProperty('options')
    expect(envelopeOnly).toMatchObject({ envelope: ENVELOPE })
    expect(emptyBag).toMatchObject({ options: {} })
  })
})

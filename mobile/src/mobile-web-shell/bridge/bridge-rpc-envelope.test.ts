import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_RPC_ENVELOPE_GRANT } from './bridge-envelope'
import {
  BridgeRpcEnvelopeInvalidError,
  BridgeRpcEnvelopeUngrantedError
} from './bridge-client-errors'
import { INIT, createPageClient, readError } from './bridge-page-client-test-harness'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'

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

  it('refuses an envelope the shell did not grant, and posts nothing', async () => {
    const page = createPageClient()
    page.start()
    const posted = page.sent.length
    const refusal = await page.client
      .sendRequest('worktree.ps', {}, { envelope: ENVELOPE })
      .catch(readError)
    expect(refusal).toBeInstanceOf(BridgeRpcEnvelopeUngrantedError)
    expect(refusal).toMatchObject({ code: 'bridge_rpc_envelope_ungranted' })
    expect(() =>
      page.client.subscribe('terminal.subscribe', {}, () => undefined, { envelope: ENVELOPE })
    ).toThrow(BridgeRpcEnvelopeUngrantedError)
    expect(page.sent).toHaveLength(posted)
  })

  it('refuses an envelope the shell reader would drop, instead of leaving the call pending', async () => {
    const page = grantedPage()
    const posted = page.sent.length
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a caller that widened the type, which the check exists for.
    const notJson = { when: new Date(0), skip: undefined } as unknown as Record<string, null>
    const refusal = await page.client
      .sendRequest('worktree.ps', {}, { envelope: notJson })
      .catch(readError)
    expect(refusal).toBeInstanceOf(BridgeRpcEnvelopeInvalidError)
    expect(refusal).toMatchObject({ code: 'bridge_rpc_envelope_invalid' })
    expect(() =>
      page.client.subscribe('terminal.subscribe', {}, () => undefined, { envelope: notJson })
    ).toThrow(BridgeRpcEnvelopeInvalidError)
    expect(page.sent).toHaveLength(posted)
  })
})

describe('bridge rpc envelope: shell side', () => {
  it('hands a request and a subscribe envelope to the native client options', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    expect(pair.client.getShellSession()?.grants.native).toContain(BRIDGE_RPC_ENVELOPE_GRANT)
    void pair.client.sendRequest('worktree.ps', { a: 1 }, { timeoutMs: 50, envelope: ENVELOPE })
    void pair.client.sendRequest('worktree.ps', undefined, { envelope: ENVELOPE })
    pair.client.subscribe('terminal.subscribe', { terminal: 't' }, () => undefined, {
      envelope: ENVELOPE
    })
    await pair.flush()
    expect(pair.rpc.requests.map((request) => request.args)).toEqual([
      ['worktree.ps', { a: 1 }, { timeoutMs: 50, envelope: ENVELOPE }],
      ['worktree.ps', undefined, { envelope: ENVELOPE }]
    ])
    expect(pair.rpc.streams.map((stream) => stream.envelope)).toEqual([ENVELOPE])
  })

  it('calls the native client exactly as before when no envelope crossed', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    void pair.client.sendRequest('worktree.ps')
    void pair.client.sendRequest('worktree.ps', { a: 1 })
    void pair.client.sendRequest('worktree.ps', { a: 1 }, { timeoutMs: 50 })
    pair.client.subscribe('terminal.subscribe', { terminal: 't' }, () => undefined)
    await pair.flush()
    expect(pair.rpc.requests.map((request) => request.args)).toEqual([
      ['worktree.ps'],
      ['worktree.ps', { a: 1 }],
      ['worktree.ps', { a: 1 }, { timeoutMs: 50 }]
    ])
    expect(pair.rpc.streams.map((stream) => stream.envelope)).toEqual([undefined])
  })
})

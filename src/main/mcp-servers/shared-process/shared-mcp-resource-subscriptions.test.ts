import { describe, expect, it } from 'vitest'
import { ErrorCode, McpError, type Result } from '@modelcontextprotocol/sdk/types.js'
import { SharedMcpResourceSubscriptions } from './shared-mcp-resource-subscriptions'

const URI = 'file:///x'
type Method = 'resources/subscribe' | 'resources/unsubscribe'

// A child that watches URI after a subscribe it answered, and stops after an unsubscribe it answered.
function harness() {
  const subscriptions = new SharedMcpResourceSubscriptions(() => true)
  const sent: string[] = []
  let watching = false
  const request = (
    method: Method,
    session: string,
    answer: () => Promise<void> = async () => {}
  ): Promise<Result> =>
    subscriptions.forward({ method, params: { uri: URI } }, session, async () => {
      sent.push(`${session} ${method}`)
      await answer()
      watching = method === 'resources/subscribe'
      return {}
    })!
  return { subscriptions, sent, request, watching: () => watching }
}

const refusal = () => Promise.reject(new McpError(ErrorCode.InternalError, 'busy'))

describe('SharedMcpResourceSubscriptions', () => {
  it('keeps the last holder when the child refuses to let go, so a retry asks the child again', async () => {
    const { subscriptions, sent, request } = harness()
    await request('resources/subscribe', 'a')
    await expect(request('resources/unsubscribe', 'a', refusal)).rejects.toThrow('busy')
    expect([...subscriptions.subscribers(URI)]).toEqual(['a'])

    await request('resources/unsubscribe', 'a')
    expect(sent).toEqual([
      'a resources/subscribe',
      'a resources/unsubscribe',
      'a resources/unsubscribe'
    ])
    expect([...subscriptions.subscribers(URI)]).toEqual([])
  })

  it('never leaves a holder the child does not watch for, whatever answers arrive late', async () => {
    const { subscriptions, request, watching } = harness()
    await request('resources/subscribe', 'a')
    let refuse!: () => void
    const late = new Promise<void>((resolve) => (refuse = resolve)).then(refusal)
    const aLeaves = request('resources/unsubscribe', 'a', () => late)
    const bJoins = request('resources/subscribe', 'b')
    const bLeaves = request('resources/unsubscribe', 'b')
    refuse()
    await expect(aLeaves).rejects.toThrow('busy')
    await Promise.all([bJoins, bLeaves])
    await request('resources/subscribe', 'c')

    expect([...subscriptions.subscribers(URI)]).toEqual(['c'])
    expect(watching()).toBe(true)
  })

  it('gives nothing back after a refusal when the first subscribe it followed failed', async () => {
    const { subscriptions, request, watching } = harness()
    let fail!: () => void
    const failing = new Promise<void>((resolve) => (fail = resolve)).then(refusal)
    const joins = request('resources/subscribe', 'a', () => failing)
    const leaves = request('resources/unsubscribe', 'a', refusal)
    await Promise.resolve()
    fail()
    await expect(leaves).rejects.toThrow('busy')
    await expect(joins).rejects.toThrow('busy')
    await request('resources/subscribe', 'b')

    expect([...subscriptions.subscribers(URI)]).toEqual(['b'])
    expect(watching()).toBe(true)
  })

  it('keeps later subscribers waiting on the newest subscribe when an older one answers late', async () => {
    const { subscriptions, request } = harness()
    let answerOld!: () => void
    let refuseNew!: () => void
    const old = request(
      'resources/subscribe',
      'a',
      () => new Promise((resolve) => (answerOld = resolve))
    )
    subscriptions.release('a')
    const replacement = request('resources/subscribe', 'b', () =>
      new Promise<void>((resolve) => (refuseNew = resolve)).then(refusal)
    )
    answerOld()
    await old

    const joins = request('resources/subscribe', 'c')
    const results = Promise.allSettled([replacement, joins])
    refuseNew()
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect([...subscriptions.subscribers(URI)]).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { CodexSharedServerRecovery } from './codex-shared-server-recovery'
import { CodexSharedServerRouter } from './codex-shared-server-router'
import { field, type CodexSharedServerFrame } from './codex-shared-server-frames'
import type { CodexSharedServerLease } from './codex-shared-server-lease'

function chatLease() {
  const delivered: CodexSharedServerFrame[] = []
  const lease = {
    threads: new Set<string>(),
    liveThreads: new Set<string>(),
    abandonedThreads: new Set<string>(),
    pendingOpens: new Set<Promise<unknown>>(),
    routable: true,
    open: true,
    reading: true,
    recoveryCut: false,
    deliver: (frame: CodexSharedServerFrame) => delivered.push(frame)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the router reads only these members.
  return { lease: lease as unknown as CodexSharedServerLease, delivered }
}

/** A reattached server's router, its frames tagged with the seq they arrived at. */
function reattachedRouter() {
  let seq = 0
  const recovery = new CodexSharedServerRecovery(
    () => {},
    () => 32 * 1024 * 1024
  )
  const leases = new Set<CodexSharedServerLease>()
  const router = new CodexSharedServerRouter(
    () => leases,
    () => {},
    recovery,
    () => seq
  )
  const send = (method: string, params: unknown) => {
    seq += 1
    router.onNotification(method, params)
  }
  const spawned = (child: string, parent: string) =>
    send('thread/started', {
      thread: { id: child, source: { subAgent: { thread_spawn: { parent_thread_id: parent } } } }
    })
  const output = (threadId: string, text: string) =>
    send('item/agentMessage/delta', { threadId, delta: text })
  return { recovery, router, leases, spawned, output }
}

const texts = (frames: CodexSharedServerFrame[]) =>
  frames.flatMap((frame) =>
    frame.kind === 'notification' && frame.method === 'item/agentMessage/delta'
      ? [String(field(frame.params, 'delta'))]
      : []
  )

describe('a reattached shared server holding its chats threads', () => {
  it('keeps a subagent’s output while its parent is unclaimed, and hands the family over in order', () => {
    const { recovery, router, leases, spawned, output } = reattachedRouter()
    recovery.expect({ sessionId: 'chat', threadId: 'parent', workload: 'w' })
    output('parent', 'p1')
    spawned('child', 'parent')
    output('child', 'c1')
    output('parent', 'p2')
    output('child', 'c2')
    // Nothing the chat hasn't taken may be acked away.
    expect(router.floor()).toBe(1)

    const { lease, delivered } = chatLease()
    leases.add(lease)
    router.claim('parent', lease, true)
    expect(texts(delivered)).toEqual(['p1', 'c1', 'p2', 'c2'])
    expect([...lease.threads].sort()).toEqual(['child', 'parent'])
    expect(recovery.empty).toBe(true)
    output('child', 'c3')
    expect(texts(delivered)).toEqual(['p1', 'c1', 'p2', 'c2', 'c3'])
  })

  it('brings an unresolved subagent and its own subagent to the chat once its owner is known', () => {
    const { recovery, router, leases, spawned, output } = reattachedRouter()
    recovery.expect({ sessionId: 'chat', threadId: 'root', workload: 'w' })
    recovery.holdUnowned('helper')
    output('helper', 'h1')
    spawned('grandchild', 'helper')
    output('grandchild', 'g1')
    output('helper', 'h2')

    const { lease, delivered } = chatLease()
    leases.add(lease)
    router.claim('root', lease, true)
    expect(texts(delivered)).toEqual([])
    router.ownerFound('helper', 'root')
    expect(texts(delivered)).toEqual(['h1', 'g1', 'h2'])
    expect(lease.threads.has('grandchild')).toBe(true)
    expect(recovery.empty).toBe(true)
  })
})

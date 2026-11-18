import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  CONNECTOR_CLIENT_LIMITS,
  type ConnectorPrompt
} from '../../shared/connectors/connector-cloud-contract'
import type { PendingPrompt } from '../../shared/agent-status/contracts/agent-pending-prompt'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import {
  ConversationEvents,
  type ConversationSnapshot
} from '../external-conversations/external-conversation-events'
import {
  chatPaneKey,
  type ChatNews,
  type EndedChatTurn
} from '../external-conversations/external-conversation-chat'
import {
  fakeLinkStore,
  WORKTREE
} from '../external-conversations/external-conversation.test-fixture'
import { ConnectorTurnEvents } from './connector-turn-events'
import { ConnectorAccountTransport } from './connector-transport'

const P: PendingPrompt = {
  kind: 'question',
  promptId: 'p',
  question: 'Question P?',
  options: [{ id: 'yes', label: 'Yes' }]
}
const Q: PendingPrompt = { ...P, promptId: 'q', question: 'Question Q?' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture(prompt: ConnectorPrompt = P, count = 1, working = false, audience = false) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-prompt-publication-'))
  dirs.push(dir)
  const records = fakeLinkStore()
  let links: ExternalConversationLink[] = Array.from({ length: count }, (_, index) => ({
    source: 'slack',
    externalId: `T1:C9:${index}:U5`,
    sessionId: `s${index}`,
    paneKey: chatPaneKey(`s${index}`),
    agent: 'codex',
    createdAt: Date.now()
  }))
  const link = links.at(-1)!
  const write = () => records.put(WORKTREE, 'local', { externalConversations: links })
  write()
  let live: PendingPrompt | null = prompt
  let heard = true
  let news!: (event: ChatNews) => void
  let latest!: ConversationSnapshot
  const ended = deferred<void>()
  const requested = deferred<void>()
  const responses: (Response | Promise<Response> | Error)[] = []
  let outbox = new ConnectorTurnEvents(dir, 'ada')
  const receiver = (capable: boolean, recreate = false) => {
    if (recreate) {
      outbox.clear()
      outbox = new ConnectorTurnEvents(dir, 'ada')
    }
    outbox.useCloudFeatures(new Set(capable ? ['prompts.audience'] : []))
  }
  receiver(audience)
  const transport = new ConnectorAccountTransport(
    'https://connector.test',
    async () => ({
      ok: true,
      value: { connectorToken: 'test-credential', expiresAt: Date.now() + 3_600_000 }
    }),
    async () => {
      requested.resolve()
      const response = responses.shift() ?? new Response(null, { status: 204 })
      if (response instanceof Error) {
        throw response
      }
      return await response
    }
  )
  const events = new ConversationEvents({
    store: records.store,
    readHookRow: () =>
      working
        ? {
            paneKey: link.paneKey,
            tabId: 'tab',
            worktreeId: WORKTREE,
            connectionId: null,
            structuredHost: 'owned',
            state: 'working',
            prompt: '',
            agentType: 'codex',
            receivedAt: Date.now(),
            stateStartedAt: 1
          }
        : null,
    onAgentPaneChange: () => () => {},
    pendingPrompt: () => live,
    promptStanding: () => 'unknown',
    promptsAudience: () => audience,
    turnOpener: () => null,
    onChatNews: (listener) => {
      news = listener
      return () => {}
    },
    chatTurnOrigin: () => 'delivery',
    chatTurnDelivered: () => heard,
    chatTurnDelivery: () => undefined,
    chatTurnWaiting: () => false,
    runningTurnReported: () => false,
    workLinks: async () => [],
    workerActivity: async () => null,
    setTimer: () => ({ cancel: () => {} }),
    now: Date.now
  })
  const watch = () =>
    events.watch((event) => {
      outbox.observe(event)
      if (event.kind === 'snapshot') {
        latest = event
      }
      if (event.kind === 'turn-ended') {
        ended.resolve()
      }
    })
  let release = watch()
  return {
    events,
    link,
    responses,
    requested,
    receiver,
    async post() {
      const head = outbox.next(1)!
      const result = await transport.call('/v1/events', { events: head.batch }, z.undefined(), {
        requests: outbox.requestsFor(head.batch)
      })
      if (result.ok) {
        outbox.accepted(head.stamp)
      } else if (result.status === 400 || result.status === 413) {
        outbox.refused(head.stamp)
      }
      return head.batch
    },
    prompt(next: PendingPrompt) {
      live = next
      news({ kind: 'prompt', sessionId: link.sessionId })
    },
    end(readTurn: () => Promise<EndedChatTurn>) {
      news({ kind: 'turn-ended', sessionId: link.sessionId, outcome: 'success', at: 5, readTurn })
      return ended.promise
    },
    keepLastLink() {
      links = [link]
      write()
    },
    reconnect() {
      release()
      heard = false
      live = null
      release = watch()
      return latest.conversations[0]!
    },
    close() {
      release()
      outbox.clear()
    }
  }
}

it('C1-2: a delayed old turn-end cannot erase a newer published prompt', async () => {
  const h = fixture()
  try {
    await h.post()
    const read = deferred<EndedChatTurn>()
    const ended = h.end(() => read.promise)
    h.prompt(Q)
    await h.post()
    read.resolve({})
    await ended
    expect(h.reconnect().prompt).toEqual(Q)
  } finally {
    h.close()
  }
})

it('C1-3: restates only the unsupported form that actually went out', async () => {
  const h = fixture({ ...P, question: 'x'.repeat(CONNECTOR_CLIENT_LIMITS.maxEventBytes + 1) })
  try {
    await h.post()
    expect(h.reconnect().prompt).toEqual({ kind: 'unsupported', promptId: 'p' })
  } finally {
    h.close()
  }
})

it('C1-3: does not restate a prompt omitted by the snapshot cap', async () => {
  const h = fixture(P, CONNECTOR_CLIENT_LIMITS.maxSnapshotConversations + 1)
  try {
    await h.post()
    h.keepLastLink()
    expect(h.reconnect().prompt).toBeNull()
  } finally {
    h.close()
  }
})

it('C1-3: an unsent snapshot cannot authorize restating its prompt', () => {
  const h = fixture()
  try {
    expect(h.reconnect().prompt).toBeNull()
  } finally {
    h.close()
  }
})

it('C1-3: a refused single snapshot cannot authorize restating its prompt', async () => {
  const h = fixture()
  try {
    h.responses.push(new Response(null, { status: 400 }))
    await h.post()
    expect(h.reconnect().prompt).toBeNull()
  } finally {
    h.close()
  }
})

it('C1-3: a lost response retains only the eligible wire form that may have applied', async () => {
  const h = fixture({ ...P, question: 'x'.repeat(CONNECTOR_CLIENT_LIMITS.maxEventBytes + 1) })
  try {
    h.responses.push(new TypeError('network'))
    await h.post()
    expect(h.reconnect().prompt).toEqual({ kind: 'unsupported', promptId: 'p' })
  } finally {
    h.close()
  }
})

it('C1-3: a superseded request that applies late retains its exact wire form', async () => {
  const h = fixture({ ...P, question: 'x'.repeat(CONNECTOR_CLIENT_LIMITS.maxEventBytes + 1) })
  const response = deferred<Response>()
  let running: Promise<unknown> | undefined
  try {
    h.responses.push(response.promise)
    running = h.post()
    await h.requested.promise
    expect(h.reconnect().prompt).toEqual({ kind: 'unsupported', promptId: 'p' })
    response.resolve(new Response(null, { status: 204 }))
    await running
    expect(h.reconnect().prompt).toEqual({ kind: 'unsupported', promptId: 'p' })
  } finally {
    response.resolve(new Response(null, { status: 204 }))
    await running
    h.close()
  }
})

it('C1-4: failed-answer restoration cannot cross an observed turn end', async () => {
  const h = fixture()
  try {
    await h.post()
    const restore = h.events.answering(h.link.paneKey, 'p')
    await h.end(async () => ({}))
    restore()
    expect(h.reconnect().prompt).toBeNull()
  } finally {
    h.close()
  }
})

it('C1-4: failed-answer restoration cannot cross unlink and relink', async () => {
  const h = fixture()
  try {
    await h.post()
    const restore = h.events.answering(h.link.paneKey, 'p')
    const linked = { link: h.link, workspace: { worktreeId: WORKTREE, sshHostId: null } }
    h.events.unlinked(linked)
    restore()
    expect(h.reconnect().prompt).toBeNull()
  } finally {
    h.close()
  }
})

it('C1-3: an untransmitted replacement cannot erase the last shown prompt', async () => {
  const h = fixture()
  try {
    await h.post()
    h.prompt(Q)
    expect(h.reconnect().prompt).toEqual(P)
  } finally {
    h.close()
  }
})

it('C1-2: a retired watch cannot deliver its delayed turn result into a new watch', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const h = fixture(P, 1, true)
  try {
    await h.post()
    const read = deferred<EndedChatTurn>()
    void h.end(() => read.promise)
    h.events.reset()
    h.reconnect()
    read.resolve({ lastAssistantMessage: 'Retired turn result' })
    await vi.advanceTimersByTimeAsync(0)
    expect(await h.post()).toEqual([expect.objectContaining({ kind: 'snapshot' })])
  } finally {
    h.close()
    vi.useRealTimers()
  }
})

it('C1-3: later source mutation cannot change the retained wire body', async () => {
  const mutable = { ...P }
  const h = fixture(mutable)
  try {
    await h.post()
    if (mutable.kind === 'question') {
      mutable.question = 'Changed after transmission'
    }
    expect(h.reconnect().prompt).toEqual(P)
  } finally {
    h.close()
  }
})

it.each([false, true])(
  'reapplies the audience gate to a retained prompt after receiver downgrade (recreated: %s)',
  async (recreate) => {
    const prompt: ConnectorPrompt = {
      ...P,
      raisedBy: 'orca',
      open: { sessionId: 's0', itemId: 'p' }
    }
    const h = fixture(prompt, 1, false, true)
    try {
      expect(await h.post()).toEqual([
        expect.objectContaining({ conversations: [expect.objectContaining({ prompt })] })
      ])
      h.receiver(false, recreate)
      expect(h.reconnect().prompt).toEqual(prompt)
      expect(await h.post()).toEqual([
        expect.objectContaining({ conversations: [expect.objectContaining({ prompt: null })] })
      ])
      h.receiver(true)
      expect(h.reconnect().prompt).toEqual(prompt)
      expect(await h.post()).toEqual([
        expect.objectContaining({ conversations: [expect.objectContaining({ prompt })] })
      ])
    } finally {
      h.close()
    }
  }
)

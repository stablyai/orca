// A send is accepted into a chat whose Claude child is gone, and its delivery restarts the child.
// When that child dies before it proves its start, the message was never handed to it — delivery
// waits for the start — so the send is rejected with the child's own diagnostic, never left as a
// delivery nobody can confirm, and a client that was subscribed the whole time receives
// that over the wire, with no row beside it. Against the production runtime, adapter,
// record store and host, with only the CLI scripted.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { waitForStructuredAgentSessionRecovery } from './structured-agent-session-runtime'
import {
  createScriptedClaudeRuntime,
  scriptedClaudeExitError
} from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-send-restart-dies-first'
const CALLER = { callerKey: 'client-1' }
const DIAGNOSTIC = 'claude stream-json exited (code 1): claude: not signed in (rig)'
const STARTUP_TEXT = 'Claude stopped before it finished starting. Send your message to try again.'

/** Delivery runs on its own serialized steps; under a loaded runner they take more than a second. */
function eventually(assertion: () => unknown): Promise<unknown> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

let claude = createScriptedClaudeRuntime([SESSION])
let operations = 0
/** The dispatch state each send was answered with, before any exit settled it. */
const answered = new Map<string, string>()

afterEach(async () => {
  vi.restoreAllMocks()
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

function fence(host: StructuredAgentSessionHost): number {
  return host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
}

function attempt(host: StructuredAgentSessionHost, text: string) {
  const body = hostTestMessage(text)
  return host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`,
      expectedRuntimeFence: fence(host),
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
}

async function send(host: StructuredAgentSessionHost, text: string): Promise<string> {
  const body = hostTestMessage(text)
  const clientOperationId = `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId,
      expectedRuntimeFence: fence(host),
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, replayed: false })
  if (sent.ok && 'submission' in sent.value) {
    answered.set(clientOperationId, sent.value.submission.dispatchState)
  }
  return clientOperationId
}

async function statusRows(host: StructuredAgentSessionHost): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' ? [item.body.text] : []
  )
}

async function submission(host: StructuredAgentSessionHost, clientMessageId: string) {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

async function failLatestStart(host: StructuredAgentSessionHost, count: number): Promise<void> {
  await eventually(() => expect(claude.children(SESSION)).toHaveLength(count))
  claude.child(SESSION).exit(scriptedClaudeExitError(DIAGNOSTIC))
  await waitForStructuredAgentSessionRecovery()
  await eventually(() =>
    expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  )
}

/** Everything a subscriber received, flattened to the rows and submissions it was shown. */
function received(events: AgentSessionSubscribeEvent[]) {
  const statusTexts: string[] = []
  const submissions = new Map<string, string>()
  const fences: number[] = []
  for (const event of events) {
    if (event.type === 'end') {
      continue
    }
    const page = event.type === 'batch' ? event.batch : event.page
    for (const item of page.items) {
      if (item.body.kind === 'status') {
        statusTexts.push(item.body.text)
      }
    }
    for (const entry of page.submissions) {
      submissions.set(
        entry.clientMessageId,
        entry.dispatchState === 'rejected' ? `rejected: ${entry.reason}` : entry.dispatchState
      )
    }
    if (event.fence !== undefined) {
      fences.push(event.fence)
    }
  }
  return { statusTexts, submissions, fences }
}

describe('a send whose restarted Claude child dies before it proves its start', () => {
  it('is rejected with the diagnostic, adds no row, and a new send is one new attempt', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    await failLatestStart(host, 1)
    const releasedFence = fence(host)

    const sent = await send(host, 'hello?')
    // Accepted: the answer comes before the restart it needs.
    expect(answered.get(sent)).toBe('pending')
    await failLatestStart(host, 2)

    // Provably not delivered, with the cause; not "unconfirmed".
    await eventually(async () =>
      expect(await submission(host, sent)).toMatchObject({
        dispatchState: 'rejected',
        reason: STARTUP_TEXT,
        rejection: { kind: 'providerStartFailed' }
      })
    )
    expect(await submission(host, sent)).not.toHaveProperty('startRetry')
    expect(await statusRows(host)).toEqual([])
    expect(fence(host)).toBe(releasedFence + 2)
    expect(claude.children(SESSION)).toHaveLength(2)
    expect(claude.child(SESSION).calls).not.toContain('send')

    // A new send: one restart, and once the CLI is healthy the message is written.
    claude.behave(SESSION, {})
    await send(host, 'hello again')
    await eventually(() => expect(claude.children(SESSION)).toHaveLength(3))
    await eventually(() => expect(claude.child(SESSION).calls).toContain('send'))
    expect(claude.child(SESSION).calls.filter((call) => call === 'send')).toHaveLength(1)
    expect(await statusRows(host)).toEqual([])
  })

  // A restart refused because its child died before it was handed over is recorded on the message,
  // in the words any failed start uses, with no row beside it.
  it.each(['spawn', 'start-time-read'] as const)(
    'records a restart whose child exits at %s on the message',
    async (at) => {
      claude.behave(SESSION, { initHangs: true })
      const host = await claude.install()
      await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
        ok: true
      })
      await failLatestStart(host, 1)

      claude.behave(SESSION, { exitsDuringSpawn: { diagnostic: DIAGNOSTIC, at } })
      const sent = await send(host, 'hello?')
      await eventually(async () =>
        expect(await submission(host, sent)).toMatchObject({
          dispatchState: 'rejected',
          reason: STARTUP_TEXT,
          rejection: { kind: 'providerStartFailed' }
        })
      )
      await waitForStructuredAgentSessionRecovery()
      expect(await submission(host, sent)).not.toHaveProperty('startRetry')

      expect(await statusRows(host)).toEqual([])
    }
  )

  it('reaches a subscriber that was open across the restart and the exit', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    const events: AgentSessionSubscribeEvent[] = []
    const unsubscribe = await host.subscribe({
      id: 'pane',
      sessionId: SESSION,
      emit: (event) => {
        events.push(event)
      }
    })
    try {
      await failLatestStart(host, 1)
      const sent = await send(host, 'hello?')
      await failLatestStart(host, 2)

      await eventually(() => {
        const seen = received(events)
        expect(seen.submissions.get(sent)).toBe(`rejected: ${STARTUP_TEXT}`)
        expect(seen.statusTexts).toEqual([])
        // The subscriber ended up on the fence the exit published, not the one the restart did.
        expect(seen.fences.at(-1)).toBe(fence(host))
      })
    } finally {
      unsubscribe()
    }
  })
})

describe('a chat whose Claude CLI keeps failing to start, seen by a subscriber open throughout', () => {
  // The stderr rides beside the sentence as a log detail; the sentence is the same every time.
  const STARTUP_FAILURE = STARTUP_TEXT

  /** Status rows a subscriber has been shown, one per row whatever frame carried it. */
  function shownRows(events: AgentSessionSubscribeEvent[]): Map<string, string> {
    const rows = new Map<string, string>()
    for (const event of events) {
      if (event.type === 'end') {
        continue
      }
      const page = event.type === 'batch' ? event.batch : event.page
      for (const item of page.items) {
        if (item.body.kind === 'status') {
          rows.set(item.itemId, item.body.text)
        }
      }
    }
    return rows
  }

  it('shows the cause on each message whose start died, however it died, and no row at all', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    const events: AgentSessionSubscribeEvent[] = []
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    const unsubscribe = await host.subscribe({
      id: 'pane',
      sessionId: SESSION,
      emit: (event) => {
        events.push(event)
      }
    })
    try {
      await failLatestStart(host, 1)

      // Send: accepted, and its delivery restarts the child, which dies before starting.
      const sent = await send(host, 'hello?')
      await failLatestStart(host, 2)
      await eventually(() =>
        expect(received(events).submissions.get(sent)).toBe(`rejected: ${STARTUP_FAILURE}`)
      )

      // Sent again while still broken: this restart dies before its child is handed over, so the
      // delivery's start is refused, and the new message says the same thing.
      claude.behave(SESSION, {
        exitsDuringSpawn: {
          diagnostic: 'claude stream-json exited (code 1): claude: not signed in (rig)',
          at: 'start-time-read'
        }
      })
      const retried = await send(host, 'hello?')
      await eventually(() =>
        expect(received(events).submissions.get(retried)).toBe(`rejected: ${STARTUP_FAILURE}`)
      )
      await waitForStructuredAgentSessionRecovery()

      // The CLI is fixed: a new send delivers.
      claude.behave(SESSION, {})
      await expect(attempt(host, 'hello?')).resolves.toMatchObject({ ok: true })
      await eventually(() => expect(claude.child(SESSION).calls).toContain('send'))
      expect(shownRows(events).size).toBe(0)
    } finally {
      unsubscribe()
    }
  })
})

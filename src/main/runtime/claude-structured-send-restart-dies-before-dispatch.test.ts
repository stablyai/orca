// A send is accepted into a chat whose Claude child is gone, and its delivery restarts the child.
// When that child dies before it proves its start, the message was never handed to it — delivery
// waits for the start — so the send settles `rejected` with the child's own diagnostic, never as a
// delivery nobody can confirm, and a client that was subscribed the whole time receives the
// failure row and the rejected submission over the wire. Against the production runtime, adapter,
// record store and host, with only the CLI scripted.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { waitForStructuredAgentSessionRecovery } from './structured-agent-session-runtime'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-send-restart-dies-first'
const CALLER = { callerKey: 'client-1' }
const DIAGNOSTIC = 'claude stream-json exited (code 1): claude: not signed in (rig)'

/** Delivery runs on its own serialized steps; under a loaded runner they take more than a second. */
function eventually(assertion: () => void): Promise<void> {
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
  if (sent.ok) {
    answered.set(clientOperationId, sent.value.submission.dispatchState)
  }
  return clientOperationId
}

function statusRows(host: StructuredAgentSessionHost): string[] {
  return host
    .journalSnapshot(SESSION)
    .items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
}

function submission(host: StructuredAgentSessionHost, clientMessageId: string) {
  return host
    .journalSnapshot(SESSION)
    .submissions.find((entry) => entry.clientMessageId === clientMessageId)
}

async function failLatestStart(host: StructuredAgentSessionHost, count: number): Promise<void> {
  await eventually(() => expect(claude.children(SESSION)).toHaveLength(count))
  claude.child(SESSION).exit(new Error(DIAGNOSTIC))
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
      submissions.set(entry.clientMessageId, entry.dispatchState)
    }
    if (event.fence !== undefined) {
      fences.push(event.fence)
    }
  }
  return { statusTexts, submissions, fences }
}

describe('a send whose restarted Claude child dies before it proves its start', () => {
  it('settles rejected with the diagnostic, keeps one failure row, and a Retry is one new attempt', async () => {
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
    await eventually(() =>
      expect(submission(host, sent)).toMatchObject({
        dispatchState: 'rejected',
        // Worded for the user: the red line under the composer shows it as it stands.
        reason: `The provider stopped before it finished starting: ${DIAGNOSTIC}.`
      })
    )
    expect(statusRows(host)).toEqual([
      expect.stringContaining('not signed in'),
      expect.stringMatching(/stopped before it finished starting: .*not signed in \(rig\)/)
    ])
    expect(fence(host)).toBe(releasedFence + 2)
    expect(claude.children(SESSION)).toHaveLength(2)
    expect(claude.child(SESSION).calls).not.toContain('send')

    // Retry under a new id: one restart, and once the CLI is healthy the message is written.
    claude.behave(SESSION, {})
    await send(host, 'hello again')
    await eventually(() => expect(claude.children(SESSION)).toHaveLength(3))
    await eventually(() => expect(claude.child(SESSION).calls).toContain('send'))
    expect(claude.child(SESSION).calls.filter((call) => call === 'send')).toHaveLength(1)
    expect(statusRows(host)).toHaveLength(2)
  })

  // A restart refused because its child died before it was handed over leaves one row, from the
  // delivery, in the words any failed start uses, and rejects the message with them.
  it.each(['spawn', 'start-time-read'] as const)(
    'leaves one row for a restart whose child exits at %s',
    async (at) => {
      claude.behave(SESSION, { initHangs: true })
      const host = await claude.install()
      await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
        ok: true
      })
      await failLatestStart(host, 1)

      claude.behave(SESSION, { exitsDuringSpawn: { diagnostic: DIAGNOSTIC, at } })
      const sent = await send(host, 'hello?')
      await eventually(() =>
        expect(submission(host, sent)).toMatchObject({
          dispatchState: 'rejected',
          reason: `The provider stopped before it finished starting: ${DIAGNOSTIC}.`
        })
      )
      await waitForStructuredAgentSessionRecovery()

      expect(statusRows(host)).toEqual([
        `The provider stopped before it finished starting: ${DIAGNOSTIC}.`,
        `The provider stopped before it finished starting: ${DIAGNOSTIC}.`
      ])
    }
  )

  it('reaches a subscriber that was open across the restart and the exit', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    const events: AgentSessionSubscribeEvent[] = []
    const unsubscribe = host.subscribe({
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
        expect(seen.submissions.get(sent)).toBe('rejected')
        expect(seen.statusTexts).toContainEqual(
          expect.stringMatching(/stopped before it finished starting: .*not signed in \(rig\)/)
        )
        // The subscriber ended up on the fence the exit published, not the one the restart did.
        expect(seen.fences.at(-1)).toBe(fence(host))
      })
    } finally {
      unsubscribe()
    }
  })
})

describe('a chat whose Claude CLI keeps failing to start, seen by a subscriber open throughout', () => {
  const STARTUP_FAILURE =
    'The provider stopped before it finished starting: claude stream-json exited (code 1): claude: not signed in (rig).'

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

  it('shows one row naming the cause per failed attempt, however the start died, and none once the CLI is fixed', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    const events: AgentSessionSubscribeEvent[] = []
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    const unsubscribe = host.subscribe({
      id: 'pane',
      sessionId: SESSION,
      emit: (event) => {
        events.push(event)
      }
    })
    try {
      await failLatestStart(host, 1)
      await eventually(() => expect([...shownRows(events).values()]).toEqual([STARTUP_FAILURE]))

      // Send: accepted, and its delivery restarts the child, which dies before starting.
      const sent = await send(host, 'hello?')
      await failLatestStart(host, 2)
      await eventually(() =>
        expect(submission(host, sent)).toMatchObject({
          dispatchState: 'rejected',
          reason: STARTUP_FAILURE
        })
      )
      await eventually(() =>
        expect([...shownRows(events).values()]).toEqual([STARTUP_FAILURE, STARTUP_FAILURE])
      )

      // Retry while still broken: this restart dies before its child is handed over, so the
      // delivery's start is refused. Still one row, saying the same thing, on the rejected message.
      claude.behave(SESSION, {
        exitsDuringSpawn: {
          diagnostic: 'claude stream-json exited (code 1): claude: not signed in (rig)',
          at: 'start-time-read'
        }
      })
      const retried = await send(host, 'hello?')
      await eventually(() =>
        expect(submission(host, retried)).toMatchObject({
          dispatchState: 'rejected',
          reason: STARTUP_FAILURE
        })
      )
      await waitForStructuredAgentSessionRecovery()
      await eventually(() =>
        expect([...shownRows(events).values()]).toEqual([
          STARTUP_FAILURE,
          STARTUP_FAILURE,
          STARTUP_FAILURE
        ])
      )

      // The CLI is fixed: Retry delivers and adds no row.
      claude.behave(SESSION, {})
      await expect(attempt(host, 'hello?')).resolves.toMatchObject({ ok: true })
      await eventually(() => expect(claude.child(SESSION).calls).toContain('send'))
      expect(shownRows(events).size).toBe(3)
    } finally {
      unsubscribe()
    }
  })
})

// A send restarts a chat's Claude child and is admitted against it while it is still starting.
// When that child dies before the send's dispatch reaches the adapter, the adapter has no session
// to hold the message for, so the dispatch throws. A child that never proved its start accepted
// nothing — input is only written after initialize — so the send settles `rejected` with the
// child's own diagnostic, never as a delivery nobody can confirm, and a client that was
// subscribed the whole time receives the failure row and the rejected submission over the wire.
// Against the production runtime, adapter, record store and host, with only the CLI scripted.

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
  await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(count))
  claude.child(SESSION).exit(new Error(DIAGNOSTIC))
  await waitForStructuredAgentSessionRecovery()
  await vi.waitFor(() =>
    expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  )
}

/** The restarted child dies the instant the send's dispatch reaches the adapter. */
function killChildAtDispatch(host: StructuredAgentSessionHost): void {
  const adapter = host.deps.adapter
  const dispatch = adapter.dispatch.bind(adapter)
  vi.spyOn(adapter, 'dispatch').mockImplementationOnce((input) => {
    claude.child(SESSION).exit(new Error(DIAGNOSTIC))
    return dispatch(input)
  })
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

describe('a send whose restarted Claude child dies before the dispatch reaches the adapter', () => {
  it('settles rejected with the diagnostic, keeps one failure row, and a Retry is one new attempt', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    await failLatestStart(host, 1)
    const releasedFence = fence(host)

    killChildAtDispatch(host)
    const sent = await send(host, 'hello?')
    // The send's own answer already says it was not delivered; it does not wait for the exit.
    expect(answered.get(sent)).toBe('rejected')
    expect(claude.children(SESSION)).toHaveLength(2)
    await waitForStructuredAgentSessionRecovery()
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    )

    // Provably not delivered, with the cause; not "unconfirmed".
    await vi.waitFor(() =>
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
    expect(claude.children(SESSION)).toHaveLength(3)
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
    expect(claude.child(SESSION).calls.filter((call) => call === 'send')).toHaveLength(1)
    expect(statusRows(host)).toHaveLength(2)
  })

  it('names the diagnostic even when the exit was fully processed before the dispatch arrived', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    await failLatestStart(host, 1)
    const adapter = host.deps.adapter
    const dispatch = adapter.dispatch.bind(adapter)
    vi.spyOn(adapter, 'dispatch').mockImplementationOnce(async (input) => {
      claude.child(SESSION).exit(new Error(DIAGNOSTIC))
      // The adapter settles and publishes the exit; the host's own settlement waits behind this send.
      await new Promise((resolve) => setTimeout(resolve, 300))
      return dispatch(input)
    })

    const sent = await send(host, 'hello?')
    expect(answered.get(sent)).toBe('rejected')
    await waitForStructuredAgentSessionRecovery()
    expect(submission(host, sent)).toMatchObject({
      dispatchState: 'rejected',
      reason: `The provider stopped before it finished starting: ${DIAGNOSTIC}.`
    })
    expect(statusRows(host)).toHaveLength(2)
  })

  // A restart refused because its child died before it was handed over leaves one row, from the
  // send, in the words any failed start uses.
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
      await expect(attempt(host, 'hello?')).resolves.toMatchObject({
        ok: false,
        refusal: { code: 'agent_session_owner_restart_failed' }
      })
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
      killChildAtDispatch(host)
      const sent = await send(host, 'hello?')
      await waitForStructuredAgentSessionRecovery()
      await vi.waitFor(() =>
        expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
      )

      await vi.waitFor(() => {
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

  it('shows one row naming the cause per failed attempt, admitted or refused, and none once the CLI is fixed', async () => {
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
      await vi.waitFor(() => expect([...shownRows(events).values()]).toEqual([STARTUP_FAILURE]))

      // Send: admitted against the restarted child, which dies before starting.
      killChildAtDispatch(host)
      const sent = await attempt(host, 'hello?')
      await waitForStructuredAgentSessionRecovery()
      expect(sent).toMatchObject({
        ok: true,
        value: { submission: { dispatchState: 'rejected', reason: STARTUP_FAILURE } }
      })
      await vi.waitFor(() =>
        expect([...shownRows(events).values()]).toEqual([STARTUP_FAILURE, STARTUP_FAILURE])
      )

      // Retry while still broken: this restart dies before its child is handed over, so the send
      // is refused before admission. Still one row, saying the same thing.
      claude.behave(SESSION, {
        exitsDuringSpawn: {
          diagnostic: 'claude stream-json exited (code 1): claude: not signed in (rig)',
          at: 'start-time-read'
        }
      })
      await expect(attempt(host, 'hello?')).resolves.toMatchObject({
        ok: false,
        refusal: {
          code: 'agent_session_owner_restart_failed',
          message: expect.stringMatching(/couldn't restart: .*not signed in \(rig\)/)
        }
      })
      await waitForStructuredAgentSessionRecovery()
      await vi.waitFor(() =>
        expect([...shownRows(events).values()]).toEqual([
          STARTUP_FAILURE,
          STARTUP_FAILURE,
          STARTUP_FAILURE
        ])
      )

      // The CLI is fixed: Retry delivers and adds no row.
      claude.behave(SESSION, {})
      await expect(attempt(host, 'hello?')).resolves.toMatchObject({ ok: true })
      await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
      expect(shownRows(events).size).toBe(3)
    } finally {
      unsubscribe()
    }
  })
})

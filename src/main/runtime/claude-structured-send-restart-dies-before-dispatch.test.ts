// Restart failure before dispatch must reject the accepted send and publish its cause to existing subscribers.

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

/** Serialized delivery can exceed one second on loaded runners. */
function eventually(assertion: () => unknown): Promise<unknown> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

let claude = createScriptedClaudeRuntime([SESSION])
let operations = 0
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
  await eventually(() => expect(claude.child(SESSION).initializing).toBe(true))
  claude.child(SESSION).exit(scriptedClaudeExitError(DIAGNOSTIC))
  await waitForStructuredAgentSessionRecovery()
  await eventually(() =>
    expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  )
}

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
  it('settles rejected with the diagnostic, keeps one failure row, and a new send can start after exhaustion', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    await failLatestStart(host, 1)
    const releasedFence = fence(host)

    const sent = await send(host, 'hello?')
    expect(answered.get(sent)).toBe('pending')
    await eventually(() => expect(claude.children(SESSION)).toHaveLength(2))
    await eventually(() => expect(claude.child(SESSION).initializing).toBe(true))
    expect(await submission(host, sent)).toMatchObject({ dispatchState: 'pending' })
    expect(claude.child(SESSION).calls).not.toContain('send')
    for (let count = 2; count <= 6; count++) {
      expect(await statusRows(host)).toEqual([STARTUP_TEXT])
      await failLatestStart(host, count)
    }

    await eventually(async () =>
      expect(await submission(host, sent)).toMatchObject({
        dispatchState: 'rejected',
        reason: STARTUP_TEXT,
        rejection: { kind: 'providerStartFailed' }
      })
    )
    expect(await statusRows(host)).toEqual([STARTUP_TEXT, STARTUP_TEXT])
    expect(fence(host)).toBe(releasedFence + 10)
    expect(claude.children(SESSION)).toHaveLength(6)

    claude.behave(SESSION, {})
    await send(host, 'hello again')
    await eventually(() => expect(claude.children(SESSION)).toHaveLength(7))
    await eventually(() => expect(claude.child(SESSION).calls).toContain('send'))
    expect(claude.child(SESSION).calls.filter((call) => call === 'send')).toHaveLength(1)
    expect(await statusRows(host)).toHaveLength(2)
  })

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
      await eventually(async () =>
        expect(await submission(host, sent)).toMatchObject({
          dispatchState: 'rejected',
          reason: STARTUP_TEXT,
          rejection: { kind: 'providerStartFailed' }
        })
      )
      await waitForStructuredAgentSessionRecovery()

      expect(await statusRows(host)).toEqual([STARTUP_TEXT, STARTUP_TEXT])
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
      for (let count = 2; count <= 6; count++) {
        expect(await statusRows(host)).toEqual([STARTUP_TEXT])
        await failLatestStart(host, count)
      }

      await eventually(() => {
        const seen = received(events)
        expect(seen.submissions.get(sent)).toBe('rejected')
        expect(seen.statusTexts).toContainEqual(STARTUP_TEXT)
        // Subscribers must finish on the exit fence, not the preceding restart fence.
        expect(seen.fences.at(-1)).toBe(fence(host))
      })
    } finally {
      unsubscribe()
    }
  })
})

describe('a chat whose Claude CLI keeps failing to start, seen by a subscriber open throughout', () => {
  const STARTUP_FAILURE = STARTUP_TEXT

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

  it('shows one row naming the cause per exhausted start, however the start died, and none once the CLI is fixed', async () => {
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
      await eventually(() => expect([...shownRows(events).values()]).toEqual([STARTUP_FAILURE]))

      const sent = await send(host, 'hello?')
      for (let count = 2; count <= 6; count++) {
        expect(await statusRows(host)).toEqual([STARTUP_TEXT])
        await failLatestStart(host, count)
      }
      await eventually(async () =>
        expect(await submission(host, sent)).toMatchObject({
          dispatchState: 'rejected',
          reason: STARTUP_FAILURE
        })
      )
      await eventually(() =>
        expect([...shownRows(events).values()]).toEqual([STARTUP_FAILURE, STARTUP_FAILURE])
      )

      // Another failed restart must still produce one cause row for its rejected send.
      claude.behave(SESSION, {
        exitsDuringSpawn: {
          diagnostic: 'claude stream-json exited (code 1): claude: not signed in (rig)',
          at: 'start-time-read'
        }
      })
      const retried = await send(host, 'hello?')
      await eventually(async () =>
        expect(await submission(host, retried)).toMatchObject({
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

      claude.behave(SESSION, {})
      await expect(attempt(host, 'hello?')).resolves.toMatchObject({ ok: true })
      await eventually(() => expect(claude.child(SESSION).calls).toContain('send'))
      expect(shownRows(events).size).toBe(3)
    } finally {
      unsubscribe()
    }
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeStructuredSessionEvent } from './structured/claude-structured-session-state'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'
import { claudeStreamJsonExitError } from './claude-stream-json-exit-error'
import { structuredAgentSessionStartFailureFact } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import {
  providerSpawnAbsence,
  withProviderSpawnAbsence
} from '../provider-process/provider-executable-missing'
import {
  PROVIDER_SPAWN_FAILURE_MARKER,
  supervisedProviderSpawnFailure
} from '../provider-process/provider-spawn-failure-report'

/** The exit error a supervised Claude connection raises when the supervisor cannot spawn `claude`. */
function supervisedSpawnEnoentExit(): Error {
  const stderr = `${PROVIDER_SPAWN_FAILURE_MARKER}${JSON.stringify({
    thrown: false,
    code: 'ENOENT',
    message: 'spawn claude ENOENT'
  })}\n`
  const status = { code: 127, signal: null, processless: false }
  const reported = supervisedProviderSpawnFailure(status.code, stderr)
  return withProviderSpawnAbsence(
    claudeStreamJsonExitError(stderr, status),
    providerSpawnAbsence(reported?.error, 'claude')
  )
}

async function startedClaude(sink: StructuredAgentSessionEventSink) {
  const claude = fakeClaude()
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = adapterFor(claude, {}, events)
  await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9', events: sink })
  const ended = async () => {
    await vi.waitFor(() => expect(events.some((event) => event.type === 'ended')).toBe(true))
    return events.find((event) => event.type === 'ended')
  }
  return { connection: claude.connections[0], ended }
}

describe('what a started Claude session says ended it', () => {
  it('says Claude stopped when the child exits on its own', async () => {
    const { connection, ended } = await startedClaude({
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {}
    })

    connection.handlers.onExit?.(new Error('claude stream-json exited (code 1): killed'))

    expect(await ended()).toMatchObject({
      cause: 'unexpected-exit',
      failure: { kind: 'providerExited' }
    })
  })

  it("names Claude's root refusal of Full access rather than a bare exit", async () => {
    const { connection, ended } = await startedClaude({
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {}
    })
    const refusal =
      '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons'

    connection.handlers.onExit?.(
      claudeStreamJsonExitError(refusal, { code: 1, signal: null, processless: false })
    )

    expect(await ended()).toMatchObject({
      cause: 'unexpected-exit',
      failure: { kind: 'fullAccessAsRoot', detail: { text: `(code 1)\n${refusal}` } }
    })
  })

  it('says the CLI was not found when the supervisor could not spawn it', async () => {
    const { connection, ended } = await startedClaude({
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {}
    })

    connection.handlers.onExit?.(supervisedSpawnEnoentExit())

    const event = await ended()
    expect(event).toMatchObject({ cause: 'unexpected-exit', failure: { kind: 'cliMissing' } })
    // An exit during startup is worded through the start-failure path, which must keep it.
    expect(
      event?.type === 'ended' && structuredAgentSessionStartFailureFact({ exit: event.failure })
    ).toMatchObject({ kind: 'cliMissing' })
  })

  it('blames Orca when a journal fault makes Orca close the child', async () => {
    const { connection, ended } = await startedClaude({
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {},
      tryAppendResolvedItemAndPublish: () => ({ accepted: false, reason: 'failed' })
    })

    connection.handlers.onMessage?.({
      type: 'system',
      subtype: 'task_notification',
      session_id: PROVIDER_SESSION_ID,
      task_id: 'task-1',
      status: 'failed',
      summary: 'failed'
    })

    expect(await ended()).toMatchObject({
      reason: 'claude background task journal sink failed',
      cause: 'unexpected-exit',
      failure: { kind: 'hostFault' }
    })
    expect(connection.closeCount).toBeGreaterThanOrEqual(1)
  })
})

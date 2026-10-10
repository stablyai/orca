// The ACP adapter behind the real host: the host's own order (a fresh sink per start, bound only
// once the start proved its owner; Close and Stop reaching a start from outside the session's
// queue), with a scripted Grok, the real record store and an on-disk journal.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { readAgentSessionFailureFact } from '../../shared/agent-session-failure'
import { withNativeChatCutTurnNotices } from '../../shared/native-chat-cut-turn-notice'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import {
  GROK_CONFIG_OPTIONS,
  PROVIDER_SESSION,
  replyChunk,
  waitFor
} from './acp-structured-adapter.test-support'
import {
  attachParams,
  hello,
  launch,
  openAttachedHostRig,
  openHostRig,
  promptIdOf,
  RESUMES,
  send,
  stop
} from './acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

/** On every reopen, Grok sends what its load may carry: the saved `reply` marked as replay, and a
 *  task the dead process left running, ended by the restart. */
function loads(reply: string, count: { loads: number }) {
  return (agent: AcpScriptedAgent) =>
    agent.on('session/load', (frame) => {
      count.loads += 1
      agent.notify('session/update', replyChunk('prompt:m1', reply, { isReplay: true }))
      agent.notify('x.ai/task_completed', {
        sessionId: PROVIDER_SESSION,
        update: {
          sessionUpdate: 'task_completed',
          task_snapshot: { task_id: 'task-orphan', command: 'sleep 600', signal: 'session_restart' }
        }
      })
      agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
    })
}

describe('reopening a Grok chat through the host', () => {
  it('loads a chat the journal holds and writes its exchange once', async () => {
    const count = { loads: 0 }
    let resumed = false
    const { host, fence, messages, exchange } = await openHostRig({
      initialize: RESUMES,
      script: loads('hi', count),
      deps: { resolveLaunch: launch(() => resumed) }
    })
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    resumed = true
    await exchange('hi', true)
    expect(await messages()).toEqual(['hello', 'hi'])
    const before = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await host.flushStreamedEvents(SESSION)
    expect(count.loads).toBe(1)
    expect(await messages()).toEqual(['hello', 'hi'])
    const after = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
    expect(after.filter((row) => row.itemId.includes('background-task'))).toEqual([])
    expect(after.filter((row) => readAgentJournalTurn(row.body))).toHaveLength(
      before.filter((row) => readAgentJournalTurn(row.body)).length
    )
    await host.close(SESSION, 'user-close')
  })

  it('shows a reply a crash cut off with the existing notice, never completed from what Grok saved', async () => {
    let resumed = false
    const { rig, host, fence, messages, exchange } = await openHostRig({
      initialize: RESUMES,
      script: loads('complete saved reply', { loads: 0 }),
      deps: { resolveLaunch: launch(() => resumed) }
    })
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    resumed = true
    await exchange('complete', false)
    // Grok dies mid-reply; the host ends its record, which moves the chat's fence.
    const cutAt = fence()
    rig.child().exit()
    await waitFor(() => expect(fence()).toBeGreaterThan(cutAt))
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await host.flushStreamedEvents(SESSION)
    expect(await messages()).toEqual(['hello', 'complete'])
    const rows = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
    expect(rows.flatMap((row) => readAgentJournalTurn(row.body)?.state ?? [])).not.toContain(
      'completed'
    )
    // The transcript explains the cut the way a Claude or Codex chat's does.
    const transcript = withNativeChatCutTurnNotices(rows, { agentName: 'Grok' })
    expect(
      transcript.some(
        (row) =>
          row.body.kind === 'status' &&
          (row.itemId.includes('cut-turn-notice') ||
            readAgentSessionFailureFact(row.body.failure)?.kind === 'providerExited')
      )
    ).toBe(true)
    await host.close(SESSION, 'user-close')
  })
})

describe('a Grok crash whose exit is not proven yet', () => {
  it('rejects a send meanwhile as never sent, and a later Stop does not turn the crash into one', async () => {
    const { rig, host, rows } = await openAttachedHostRig()
    const child = rig.child()
    await send(host, 'hello')
    const prompt = await rig.frame('session/prompt')
    child.agent.notify('session/update', replyChunk(promptIdOf(prompt), 'partial'))
    await rig.settle()
    let proves = false
    child.proveClose = async () => {
      if (proves) {
        child.exit()
      }
      return proves
    }
    child.stderr = 'panic: out of memory'
    // Both pipes close as the process dies, before its exit is seen.
    child.agent.close()
    await rig.settle()
    const next = await send(host, 'next')
    await waitFor(async () =>
      expect(
        (await host.journalSnapshot(SESSION)).submissions.find(
          (entry) => entry.clientMessageId === next
        )
      ).toMatchObject({
        dispatchState: 'rejected',
        reason: 'Grok stopped before this message was sent.'
      })
    )
    await stop(host)
    proves = true
    child.exit()
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
    const transcript = withNativeChatCutTurnNotices(await rows(), { agentName: 'Grok' })
    // The crash's own notice, as for any crash; not a Stop's.
    expect(
      transcript.flatMap((row) =>
        row.body.kind === 'status'
          ? [{ text: row.body.text, failure: readAgentSessionFailureFact(row.body.failure)?.kind }]
          : []
      )
    ).toEqual([
      {
        text: 'Grok stopped while this response was in progress. You can continue in this conversation.',
        failure: 'providerExited'
      }
    ])
    await host.close(SESSION, 'user-close')
  })
})

describe('closing or stopping a Grok chat while it starts', () => {
  it('keeps a failed start whose child is not proven gone; a close leaves it, the next start asks it again', async () => {
    const { rig, host } = await openHostRig({
      script: (agent) => agent.on('initialize', () => {})
    })
    const attaching = host.attach(CALLER, attachParams()).catch((error: unknown) => error)
    await rig.frame('initialize')
    const child = rig.child()
    child.proveClose = vi.fn(async () => false)
    await host.close(SESSION, 'user-close')
    expect(await attaching).toMatchObject({ name: 'AgentSessionAcquisitionExitUnprovenError' })
    child.proveClose = vi.fn(async () => {
      child.exit()
      return true
    })
    await host.close(SESSION, 'user-close')
    expect(child.proveClose).not.toHaveBeenCalled()
    expect(child.exited).toBe(false)
    // As Claude's: the next start asks the child again before it spawns another.
    await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body: hello }),
      body: hello
    })
    await waitFor(() => expect(child.exited).toBe(true))
    await waitFor(() => expect(rig.child()).not.toBe(child))
    await host.close(SESSION, 'user-close')
  })

  it('lets a Stop reach a child Grok never finished initializing', async () => {
    const { rig, host } = await openHostRig({
      script: (agent) => agent.on('initialize', () => {})
    })
    const attaching = host.attach(CALLER, attachParams())
    await rig.frame('initialize')
    const stopping = host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
    // With no close behind it.
    await waitFor(() => expect(rig.child().exited).toBe(true))
    expect((await attaching).ok).toBe(false)
    expect(await stopping).toMatchObject({ ok: true })
    expect(rig.spawned.filter((step) => step === 'spawn')).toHaveLength(1)
  })

  it('cancels a queued send whose start a Stop ended, with no start failure in the chat', async () => {
    let spawns = 0
    const { rig, host } = await openHostRig({
      script: (agent) => {
        spawns += 1
        if (spawns > 1) {
          agent.on('initialize', () => {})
        }
      }
    })
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    // The chat closes; the next send has to start Grok again, and that start never answers.
    await host.close(SESSION, 'user-close')
    await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body: hello }),
      body: hello
    })
    await waitFor(() => expect(spawns).toBe(2))
    await rig.frame('initialize')
    const restarted = rig.child()
    expect(
      await host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
    ).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(restarted.exited).toBe(true)
    await host.flushStreamedEvents(SESSION)
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    expect(journal.submissions()).toMatchObject([
      { dispatchState: 'rejected', rejection: { kind: 'cancelled' } }
    ])
    const rows = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
    expect(rows.filter((row) => row.body.kind === 'status')).toEqual([])
    await host.close(SESSION, 'user-close')
  })

  it('leaves a start alone for a Stop that names a turn of a child already gone', async () => {
    const { rig, host } = await openHostRig({
      script: (agent) => agent.on('initialize', () => {})
    })
    const attaching = host.attach(CALLER, attachParams())
    await rig.frame('initialize')
    const stopping = host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', { turnId: 'turn-of-an-old-child' }),
      turnId: 'turn-of-an-old-child'
    })
    await rig.settle()
    expect(rig.child().closes).toBe(0)
    await host.close(SESSION, 'user-close')
    await attaching
    await stopping
  })

  it('never spawns a child for a start closed while its launch was still resolving', async () => {
    let releaseLaunch: () => void = () => {}
    const resolving = { started: false }
    const { rig, host } = await openHostRig({
      deps: {
        resolveLaunch: async () => {
          resolving.started = true
          await new Promise<void>((resolve) => {
            releaseLaunch = resolve
          })
          return launch(() => false)()
        }
      }
    })
    const attaching = host.attach(CALLER, attachParams()).catch((error: unknown) => error)
    await waitFor(() => expect(resolving.started).toBe(true))
    const closing = host.close(SESSION, 'user-close')
    releaseLaunch()
    expect(await attaching).toMatchObject({ name: 'AgentSessionPreSpawnError' })
    await closing
    expect(rig.spawned).toEqual([])
    expect(await rig.adapter.closeSession(SESSION)).toBe(true)
  })
})

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { AgentSessionRecoveryCapsule } from '../../../../runtime/agent-session/records/agent-session-recovery-capsule'
import { expect, it, vi } from 'vitest'
import {
  interruptedRestart,
  startAgent
} from './structured-agent-session-restart-interruption-test-harness'
import {
  CALLER,
  envelope,
  hostTestState,
  attach,
  seedApproval
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  HOST_TEST_NOW as NOW,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { AgentSessionStatusEvent } from '../../../../../shared/agent-session/agent-session-wire'

it('keeps a saved question visible without a provider, then atomically answers and replays one ordinary message', async () => {
  const { host, root, dispatch } = await interruptedRestart('question')
  await host.reconcileRestartLeases()
  const statuses: AgentSessionStatusEvent[] = []
  host.subscribeStatus({ id: 'question-status', emit: (event) => statuses.push(event) })
  const page = await host.history({ sessionId: SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  const prompt = page.page.items.find((item) => item.body.kind === 'question')!
  expect(page.page.actionablePromptIds).toEqual([prompt.itemId])
  expect(host.loadedSessionIds()).toEqual([])
  expect(await host.restartResume.list()).toEqual([])
  expect(
    statuses.flatMap((event) =>
      event.type === 'status'
        ? [event.session.status]
        : event.type === 'snapshot'
          ? event.sessions.map((session) => session.status)
          : []
    )
  ).toContain('attention')
  const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'main' }
  const params = {
    ...fields,
    kind: 'question' as const,
    envelope: envelope('agentSession.respondTo:question', fields)
  }
  const db = openTestJournalHostDatabase(root).db
  db.exec(`CREATE TRIGGER reject_answer BEFORE INSERT ON agent_session_command_receipts
    WHEN NEW.method = 'agentSession.respondTo:question'
    BEGIN SELECT RAISE(ABORT, 'answer not saved'); END`)
  await expect(host.respondToPrompt(CALLER, params)).rejects.toThrow('answer not saved')
  expect((await host.journalSnapshot(SESSION)).submissions).toEqual([])
  expect(
    (await host.journalSnapshot(SESSION)).items.find((item) => item.itemId === prompt.itemId)?.body
  ).toMatchObject({ resolution: { state: 'pending' } })
  db.exec('DROP TRIGGER reject_answer')
  expect(await host.respondToPrompt(CALLER, params)).toMatchObject({ ok: true })
  await vi.waitFor(() =>
    expect(dispatch.mock.calls[0]?.[0].body).toEqual({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Which branch should I use?\nMy answer: Main' }]
    })
  )
  expect(await host.respondToPrompt(CALLER, params)).toMatchObject({ ok: true, replayed: true })
  expect(
    (await host.journalSnapshot(SESSION)).submissions.map((entry) => entry.clientMessageId)
  ).toEqual([params.envelope.clientOperationId])
})

it('lets Stop retire dormant attention and keeps it retired after a later host shutdown', async () => {
  const { host } = await interruptedRestart('question')
  await host.reconcileRestartLeases()
  const stopped = await host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
  expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
  await host.close(SESSION, 'evict')
  const page = await host.history({ sessionId: SESSION, direction: 'tail' })
  expect(page).toMatchObject({ ok: true, page: { actionablePromptIds: [] } })
  expect(host.loadedSessionIds()).toEqual([])
})

it('leaves a chat with only human-waiting children dormant', async () => {
  const { host, marker } = await interruptedRestart('waiting-children')
  expect(marker).toBeNull()
  expect(await host.restartResume.list()).toEqual([])
  expect(host.loadedSessionIds()).toEqual([])
})

it('keeps mixed background work recoverable while its question stays live', async () => {
  const { host, marker } = await interruptedRestart('mixed')
  expect(marker?.work).toEqual({ kind: 'turn', id: 'interrupted-turn' })
  await host.reconcileRestartLeases()
  expect(await host.restartResume.list()).toMatchObject([{ sessionId: SESSION }])
  const page = await host.history({ sessionId: SESSION, direction: 'tail' })
  expect(page).toMatchObject({ ok: true, page: { actionablePromptIds: [expect.any(String)] } })
  expect(host.loadedSessionIds()).toEqual([])
})

it('keeps a saved approval answerable and delivers its choice as a new user message', async () => {
  const { host, dispatch } = await interruptedRestart('approval')
  await host.reconcileRestartLeases()
  expect(host.loadedSessionIds()).toEqual([])
  expect(await host.restartResume.list()).toEqual([])
  const page = await host.history({ sessionId: SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  const prompt = page.page.items.find((item) => item.body.kind === 'approval')!
  expect(page.page.actionablePromptIds).toEqual([prompt.itemId])
  const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'allow' }
  expect(
    await host.respondToPrompt(CALLER, {
      ...fields,
      kind: 'approval',
      envelope: envelope('agentSession.respondTo:approval', fields)
    })
  ).toMatchObject({ ok: true })
  await vi.waitFor(() =>
    expect(dispatch.mock.calls[0]?.[0].body).toEqual({
      kind: 'message',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: 'For your saved request: Run the command?\ngit status\nMy choice: Allow. Recheck the action and continue the unfinished task using this instruction.'
        }
      ]
    })
  )
  expect(
    (await host.journalSnapshot(SESSION)).items.find((item) => item.itemId === prompt.itemId)?.body
  ).toMatchObject({ resolution: { state: 'resolved', selectedOptionId: 'allow' } })
})

it('keeps a live callback answerable after a newer personal message', async () => {
  await attach()
  const { host, answerPrompt } = hostTestState()
  const prompt = await seedApproval()
  const body = hostTestMessage('Continue the other work while I decide')
  expect(
    await host.send(CALLER, {
      body,
      envelope: envelope('agentSession.send', { body }),
      userSend: true
    })
  ).toMatchObject({ ok: true })
  const page = await host.history({ sessionId: SESSION, direction: 'tail' })
  expect(page).toMatchObject({ ok: true, page: { actionablePromptIds: [prompt.itemId] } })
  const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'allow' }
  expect(
    await host.respondToPrompt(CALLER, {
      ...fields,
      kind: 'approval',
      envelope: envelope('agentSession.respondTo:approval', fields)
    })
  ).toMatchObject({ ok: true })
  expect(answerPrompt).toHaveBeenCalledOnce()
})

it('recovers an executing lead beside a saved question without autonomous children', async () => {
  await attach()
  const state = hostTestState()
  await seedApproval()
  await state.host.close(SESSION, 'evict')
  await startAgent(state)
  const events = state.acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('missing provider events')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'automated-work', ordinal: 1 },
    { kind: 'turn', turnId: 'automated-work', state: 'running' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await state.host.flushStreamedEvents(SESSION)
  expect(await state.host.history({ sessionId: SESSION, direction: 'tail' })).toMatchObject({
    ok: true,
    page: { actionablePromptIds: [expect.any(String)] }
  })
  await state.host.flushAllStreamedEvents()
  expect(
    (await new AgentSessionRecoveryCapsule(state.root).list(NOW)).map((entry) => entry.work)
  ).toEqual([{ kind: 'turn', id: 'automated-work' }])
})

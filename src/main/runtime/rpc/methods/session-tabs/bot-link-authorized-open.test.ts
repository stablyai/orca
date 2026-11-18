import { afterEach, expect, it, vi } from 'vitest'
import {
  createChat,
  host,
  runtime,
  dispatcher,
  WORKTREE
} from './structured-chat-tab-table.test-fixture'
import {
  HOST_TEST_SESSION,
  HOST_TEST_LOCATION
} from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import type { BotLinkOpenTarget } from '../../../../../shared/bots/bot-link-open-target'
import { makeTestBot } from '../../../../bots/bot.test-fixture'
import {
  harness,
  deferred
} from '../../../../external-conversations/external-conversation-seam.test-fixture'
import { writeLink } from '../../../../external-conversations/external-conversation-links'
import { isOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'
import { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { availableRevealWorkspace } from '../../../session-tabs/chat/structured-workspace-authority.test-fixture'
import {
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'

let conversations: ReturnType<typeof harness> | undefined
const conversation = { source: 'slack', externalId: 'C1:123' } as const
const phone = {
  pairedDeviceId: 'phone-a',
  clientKind: 'mobile' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

afterEach(() => {
  structuredWorkerIdentities.forget('structworker_link-test')
  conversations?.seam.dispose('connectors_disabled')
  conversations?.db.close()
  conversations = undefined
})

it('refuses a worker handed to another lead while its visibility writer is paused', async () => {
  await createChat(HOST_TEST_SESSION)
  await createChat('session-worker')
  await host.setSessionTabVisibility('session-worker', false, undefined, { background: true })
  await createChat('session-other')
  const guard = authorize('session-worker')
  const db = conversations!.db
  const otherLead = 'session-other'
  if (!isOrcaSessionId(HOST_TEST_SESSION) || !isOrcaSessionId(otherLead)) {
    throw new Error('invalid fixture session')
  }
  const identity = structuredWorkerIdentities.register({
    handle: 'structworker_link-test',
    sessionId: 'session-worker',
    agent: 'codex',
    paneKey: mintStructuredWorkerPaneKey('session-worker'),
    processIncarnation: structuredWorkerProcessIncarnation('session-worker'),
    worktreeId: HOST_TEST_LOCATION.workspaceId,
    hostScope: { kind: 'local', hostId: 'local' }
  })
  const dispatch = db.createDispatchContext({
    taskId: db.createTask({ runId: 'run_legacy_local', spec: 'worker' }).id,
    assigneeHandle: identity.handle,
    assigneePaneKey: identity.paneKey,
    processIncarnation: identity.processIncarnation,
    creator: { kind: 'session', orcaSessionId: HOST_TEST_SESSION },
    maxDepth: 10
  })
  const resource = db.createWorkerTerminalResourceStatement({
    dispatchId: dispatch.id,
    terminalHandle: identity.handle,
    paneKey: identity.paneKey,
    processIncarnation: identity.processIncarnation,
    worktreeId: identity.worktreeId,
    ownership: 'owned',
    hostScope: JSON.stringify(identity.hostScope)
  })
  guard.workerDispatchId = dispatch.id
  const before = await selectOtherChat()
  const entered = deferred<void>(),
    release = deferred<void>()
  const database = host.deps.journalDatabase
  const effects = database.effects.bind(database)
  vi.spyOn(database, 'effects').mockImplementation(async (input) => {
    if (
      input.some(
        (effect) =>
          effect.kind === 'store' &&
          effect.mutation.input.kind === 'command' &&
          effect.mutation.input.command.kind === 'tab-visibility' &&
          effect.mutation.input.command.visible
      )
    ) {
      entered.resolve()
      await release.promise
    }
    return effects(input)
  })
  const opening = reveal(guard)
  await entered.promise
  db.completeDispatch(dispatch.id)
  const next = db.createDispatchContext({
    taskId: db.createTask({ runId: 'run_legacy_local', spec: 'next lead' }).id,
    assigneeHandle: 'structworker_new-owner',
    creator: { kind: 'session', orcaSessionId: otherLead },
    maxDepth: 10
  })
  db.transferWorkerTerminalResourceStatement({
    resourceId: resource.id,
    toDispatchId: next.id,
    terminalHandle: identity.handle,
    paneKey: identity.paneKey,
    processIncarnation: identity.processIncarnation,
    hostScope: JSON.stringify(identity.hostScope)
  })
  release.resolve()
  expect(await opening).toMatchObject({ ok: false, error: { message: 'bot_link_target_changed' } })
  expect((await runtime.listMobileSessionTabs(WORKTREE, phone.pairedDeviceId)).activeTabId).toBe(
    before.activeTabId
  )
})

function authorize(sessionId = HOST_TEST_SESSION): BotLinkOpenTarget {
  conversations = harness(undefined, new OrchestrationDb(':memory:'))
  vi.spyOn(runtime.bots, 'list').mockReturnValue([makeTestBot({ id: 'bot' })])
  vi.spyOn(runtime, 'getExternalConversationSeam').mockReturnValue(conversations.seam)
  vi.spyOn(runtime, 'getOrchestrationDb').mockReturnValue(conversations.db)
  conversations.put(HOST_TEST_LOCATION.workspaceId, 'local', {})
  relink(HOST_TEST_SESSION)
  return {
    botId: 'bot',
    conversation,
    leadSessionId: HOST_TEST_SESSION,
    sessionId,
    worktreeId: HOST_TEST_LOCATION.workspaceId,
    itemId: 'question-A'
  }
}

function relink(sessionId: string): void {
  writeLink(
    conversations!.store,
    { worktreeId: HOST_TEST_LOCATION.workspaceId, sshHostId: null },
    {
      ...conversation,
      sessionId,
      agent: 'codex',
      paneKey: `chat:${sessionId}`,
      bot: { kind: 'bot-chat', botId: 'bot' },
      createdAt: 1
    }
  )
}

function reveal(guard: BotLinkOpenTarget) {
  return dispatcher.dispatch(
    {
      id: 'link',
      authToken: 'token',
      method: 'agentSession.reveal',
      params: { sessionId: guard.sessionId, navigation: 'caller', botLinkTarget: guard }
    },
    phone
  )
}

async function selectOtherChat() {
  runtime.selectCreatedMobileSessionTabForClient(
    HOST_TEST_LOCATION.workspaceId,
    { sessionId: 'session-other' },
    phone.pairedDeviceId
  )
  return runtime.listMobileSessionTabs(WORKTREE, phone.pairedDeviceId)
}

it('opens an exact target whose conversation association remains authoritative', async () => {
  await createChat(HOST_TEST_SESSION)
  const guard = authorize()
  expect(await reveal(guard)).toMatchObject({
    ok: true,
    result: { ok: true, sessionId: HOST_TEST_SESSION }
  })
})

it('rejects a conversation relinked while the host prepares publication, before opening it', async () => {
  await createChat(HOST_TEST_SESSION)
  await createChat('session-other')
  const guard = authorize()
  const before = await selectOtherChat()
  const entered = deferred<void>(),
    release = deferred<void>()
  vi.spyOn(runtime, 'prepareStructuredAgentSessionRevealWorkspace').mockImplementation(
    async (location) => {
      entered.resolve()
      await release.promise
      return availableRevealWorkspace(location)
    }
  )
  const opening = reveal(guard)
  await entered.promise
  relink('session-other')
  release.resolve()
  expect(await opening).toMatchObject({ ok: false, error: { message: 'bot_link_target_changed' } })
  expect((await runtime.listMobileSessionTabs(WORKTREE, 'phone-a')).activeTabId).toBe(
    before.activeTabId
  )
})

it('rejects removal of a worker from its lead while preparing publication', async () => {
  await createChat(HOST_TEST_SESSION)
  await createChat('session-worker')
  await createChat('session-other')
  const guard = authorize('session-worker')
  const db = conversations!.db
  if (!isOrcaSessionId(HOST_TEST_SESSION)) {
    throw new Error('invalid fixture session')
  }
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'worker' })
  const dispatch = db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'orca_session_id:session-worker',
    creator: { kind: 'session', orcaSessionId: HOST_TEST_SESSION },
    maxDepth: 10
  })
  guard.workerDispatchId = dispatch.id
  const before = await selectOtherChat()
  const entered = deferred<void>(),
    release = deferred<void>()
  vi.spyOn(runtime, 'prepareStructuredAgentSessionRevealWorkspace').mockImplementation(
    async (location) => {
      entered.resolve()
      await release.promise
      return availableRevealWorkspace(location)
    }
  )
  const opening = reveal(guard)
  await entered.promise
  db.db
    .prepare('UPDATE dispatch_contexts SET creator_orca_session_id = NULL WHERE id = ?')
    .run(dispatch.id)
  release.resolve()
  expect(await opening).toMatchObject({ ok: false, error: { message: 'bot_link_target_changed' } })
  expect((await runtime.listMobileSessionTabs(WORKTREE, 'phone-a')).activeTabId).toBe(
    before.activeTabId
  )
})

it('rejects a relink after preparing activation while the final inventory read awaits', async () => {
  await createChat(HOST_TEST_SESSION)
  await createChat('session-other')
  const guard = authorize()
  const before = await selectOtherChat()
  const target = before.tabs.find(
    (tab) => tab.type === 'agent-session' && tab.sessionId === HOST_TEST_SESSION
  )!
  vi.spyOn(runtime, 'getExternalConversationSeam').mockImplementationOnce(() => {
    queueMicrotask(() => relink('session-other'))
    return conversations!.seam
  })
  const opening = dispatcher.dispatch(
    {
      id: 'link',
      authToken: 'token',
      method: 'session.tabs.activate',
      params: {
        worktree: WORKTREE,
        tabId: target.id,
        navigation: 'caller',
        botLinkTarget: guard
      }
    },
    phone
  )
  expect(await opening).toMatchObject({ ok: false, error: { message: 'bot_link_target_changed' } })
  expect((await runtime.listMobileSessionTabs(WORKTREE, 'phone-a')).activeTabId).toBe(
    before.activeTabId
  )
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host/execution-host'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { closeBotsDbStores, handleBotsDbRequest } from './db-worker/bots-db-worker-entry'
import {
  createSlackExecutionId,
  authorizeSlackExecutionSend
} from '../native-chat/agent-session-wire/operations/slack-execution-authority'
import { createSlackScopedExecutions } from './slack-scoped-execution'
import { answerCodexSlackMemory } from '../codex/structured/prompts/codex-slack-memory'
import { CODEX_STRUCTURED_AGENT } from '../codex/structured/launch/codex-structured-agent-definition'
import {
  codexConnectionOpener,
  opensSharedCodexServer
} from '../codex/structured/acquisition/codex-structured-connection-opener'
import { composeStructuredLaunchRead } from '../runtime/agent-session/launch/structured-agent-launch-composition'
import { structuredAgentSessionSendBlock } from '../native-chat/agent-session-wire/operations/structured-agent-session-send-preparation'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'

it('keeps Slack-scoped sessions out of the experimental shared Codex server', () => {
  const deps = { sharedServers: () => true }
  expect(opensSharedCodexServer(codexConnectionOpener(deps, 'ordinary', {}, 'linux'))).toBe(true)
  expect(
    opensSharedCodexServer(codexConnectionOpener(deps, createSlackExecutionId(), {}, 'linux'))
  ).toBe(false)
})

it('restores only the bound requester memory and refuses alternate admission after restart', async ({
  onTestFinished
}) => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-slack-binding-'))
  onTestFinished(async () => {
    closeBotsDbStores()
    await rm(dir, { recursive: true, force: true })
  })
  const service = () =>
    createSlackScopedExecutions(() => join(dir, 'scoped'), {
      call: async (store, path, op, args) => {
        const result = await handleBotsDbRequest({ id: 1, store, path, op, args })
        if (!result.ok) {
          throw new Error(result.error)
        }
        return result.value
      }
    })
  const sessionId = createSlackExecutionId()
  const location: AgentSessionExecutionLocation = {
    workspaceId: 'folder:bot-home',
    workspaceKind: 'folder' as const,
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    wslDistro: null
  }
  const record = {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })),
    location,
    provider: 'codex',
    providerHandleChain: [],
    accountHome: { variable: 'CODEX_HOME' as const, path: join(dir, 'codex') }
  }
  const reply = {
    account: 'account',
    conversation: { source: 'slack' as const, externalId: 'T1:C1:100.001' },
    deliveryId: 'delivery'
  }
  const binding = {
    botId: 'bot',
    workspaceId: location.workspaceId,
    operationId: 'operation',
    reply,
    requester: { teamId: 'T1', userId: 'U1' }
  }
  const before = service()
  await before.reserve(sessionId, binding)
  const other = { ...record, sessionId: createSlackExecutionId() }
  await before.reserve(other.sessionId, {
    ...binding,
    requester: { teamId: 'T1', userId: 'U2' }
  })
  await (await before.forLaunch(record)).memory.remember('Alice only', '2026-11-22')
  await (await before.forLaunch(other)).memory.remember('Bob only', '2026-11-22')
  await expect(before.reserve(sessionId, { ...binding, requester: null })).rejects.toThrow()
  closeBotsDbStores()
  const after = service()
  const aliceLaunch = await after.forLaunch(record)
  const bobLaunch = await after.forLaunch(other)
  const launch = composeStructuredLaunchRead<{
    instructions: string | null
    readOnly: string | null
  }>(
    CODEX_STRUCTURED_AGENT,
    {
      store: {
        selectWritableRecord: () => ({ kind: 'writable', record }),
        requireWritableRecord: () => record,
        pinLaunchDirectory: async () => {
          throw new Error('Pinned the bot home')
        }
      },
      resolveWorkspacePath: async () => {
        throw new Error('Reached the bot home')
      },
      resolveBaseEnvironment: async () => ({}),
      resolveAgentEnvironment: async () => ({}),
      resolveInstructions: async () => 'Owner shared memory',
      resolveSlackExecutionLaunch: after.forLaunch
    },
    async (basis) => ({
      launch: { instructions: await basis.instructions(), readOnly: basis.readOnly },
      env: {},
      inheritedEnvToDelete: []
    })
  )
  const composed = await launch({
    sessionId,
    workspaceId: location.workspaceId,
    hostId: location.executionHostId,
    agent: 'codex',
    providerHandle: null
  })
  expect(composed.cwd).toBe(join(dir, 'scoped', 'executions', sessionId))
  expect(composed.instructions).toContain('Alice only')
  expect(composed.instructions).not.toContain('Owner shared memory')
  expect(composed.readOnly).toBe('reply-only')
  expect(structuredAgentSessionSendBlock(record)).toMatchObject({ ok: false })
  expect(await aliceLaunch.instructions()).toContain('Alice only')
  expect(await aliceLaunch.instructions()).not.toContain('Bob only')
  expect(await bobLaunch.memory.forget('Alice only')).toBe(false)
  const codex = {
    threadId: 'thread-alice',
    activeTurnIds: new Set(['turn-alice']),
    slackMemory: aliceLaunch.memory
  }
  const call = (params: unknown) =>
    answerCodexSlackMemory(codex, { method: 'item/tool/call', params })
  const tool = {
    threadId: 'thread-alice',
    turnId: 'turn-alice',
    namespace: null,
    tool: 'orca_slack_memory',
    arguments: { operation: 'read' }
  }
  expect(await call(tool)).toMatchObject({ success: true })
  expect(JSON.stringify(await call(tool))).toContain('Alice only')
  expect(await call({ ...tool, threadId: 'thread-bob' })).toMatchObject({ success: false })
  expect(await call({ ...tool, turnId: 'wrong-turn' })).toMatchObject({ success: false })
  expect(
    await call({
      ...tool,
      arguments: { operation: 'remember', fact: 'Likes outlines', topic: 'format' }
    })
  ).toMatchObject({ success: true })
  expect(await codex.slackMemory.readTopic('format')).toContain('Likes outlines')
  expect(await bobLaunch.memory.readTopic('format')).toBeNull()
  expect(await call({ ...tool, arguments: { operation: 'read', userId: 'U2' } })).toMatchObject({
    success: false
  })
  expect(
    await call({ ...tool, arguments: { operation: 'forget', fact: 'Alice only' } })
  ).toMatchObject({ success: true })
  expect(await aliceLaunch.memory.read()).toMatchObject({ index: '' })
  expect(await bobLaunch.memory.read()).toMatchObject({
    index: '- 2026-11-22 Bob only\n'
  })
  await expect(
    after.forLaunch({ ...record, sessionId: createSlackExecutionId() })
  ).rejects.toThrow()
  await expect(
    after.forLaunch({ ...record, location: { ...location, workspaceId: 'wrong' } })
  ).rejects.toThrow()

  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Use my preferences' }],
    origin: 'connector',
    connectorDelivery: reply,
    asker: {
      source: 'slack',
      role: 'member',
      userId: 'U1',
      place: { id: 'C1', kind: 'public_channel' },
      slackRequester: binding.requester
    }
  }
  const envelope = {
    sessionId,
    clientOperationId: 'operation',
    expectedRuntimeFence: 1,
    payloadFingerprint: ''
  }
  const admit = (beforeRun?: () => void) => ({
    envelope,
    body,
    beforeRun,
    delivery: 'queue-if-active' as const
  })
  const authorized = authorizeSlackExecutionSend(sessionId, () => {})
  expect(await after.allowsSend(record, admit(authorized))).toBe(true)
  expect(await after.allowsSend(record, admit())).toBe(false)
  expect(
    await after.allowsSend(
      record,
      admit(() => {})
    )
  ).toBe(false)
  expect(
    await after.allowsSend(record, {
      ...admit(authorizeSlackExecutionSend(other.sessionId, () => {}))
    })
  ).toBe(false)
  expect(
    await after.allowsSend(record, {
      ...admit(authorized),
      body: {
        ...body,
        asker: { ...body.asker!, userId: 'U2', slackRequester: { teamId: 'T1', userId: 'U2' } }
      }
    })
  ).toBe(false)
})

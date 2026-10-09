import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { storedAgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeControlRequestTimeoutError } from '../../claude/claude-agent-sdk-control-requests'
import { claudeStructuredPermissionOptions } from '../../claude/claude-structured-permission-mode'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>
let releaseControls = () => {}

beforeEach(async () => {
  releaseControls = () => {}
  root = await mkdtemp(join(tmpdir(), 'orca-claude-permission-order-'))
  resetHostTestOperationIds()
  const log = recordingStructuredAgentSessionLogger()
  claude = fakeClaude({ replayUuid: null })
  const openConnection = vi.fn(claude.openConnection)
  const lifecycle: Promise<void>[] = []
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => {
      const record = store.getRecord(SESSION)
      const resumed = (record?.providerHandleChain.length ?? 0) > 0
      const permissionMode = storedAgentChatPermissionMode('claude', record?.options) ?? 'bypass'
      return {
        pathToClaudeCodeExecutable: 'claude',
        options: claudeStructuredPermissionOptions(permissionMode),
        cwd: root,
        claudeConfigDir: join(root, 'claude-home'),
        providerSessionId: PROVIDER_SESSION_ID,
        resumeLeafUuid: null,
        resumesTranscript: resumed,
        continuesChain: resumed,
        permissionMode
      }
    },
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    persistHandle: async () => undefined,
    logger: log.logger,
    openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexAgents(adapter),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    logger: log.logger,
    idleSweep: { intervalMs: 3_600_000 },
    now: () => NOW
  })
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await adapter.awaitOptionWritable(SESSION)
  await Promise.all(lifecycle)
  expect(await pick('bypass')).toMatchObject({ ok: true })
})

afterEach(async () => {
  releaseControls()
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function envelope(
  method: 'agentSession.send' | 'agentSession.setOption' | 'agentSession.cancel',
  fields: Parameters<typeof computeAgentSessionPayloadFingerprint>[0]['fields']
) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

function pick(value: string) {
  const fields = { key: 'permissionMode', value }
  return host.setOption(CALLER, { envelope: envelope('agentSession.setOption', fields), ...fields })
}

type HeldControl = { mode: PermissionMode; reply: () => void }

function holdControls() {
  const connection = claude.connections[0]
  const controls: HeldControl[] = []
  releaseControls = () => controls.forEach((control) => control.reply())
  let providerMode: PermissionMode = 'bypassPermissions'
  let lost = true
  const setPermissionMode = vi.spyOn(connection, 'setPermissionMode').mockImplementation((mode) => {
    providerMode = mode
    if (lost) {
      lost = false
      return Promise.reject(new ClaudeControlRequestTimeoutError('set_permission_mode'))
    }
    return new Promise<void>((resolve) => controls.push({ mode, reply: resolve }))
  })
  const policiesAtWrite: PermissionMode[] = []
  const send = connection.send
  vi.spyOn(connection, 'send').mockImplementation((...args) => {
    policiesAtWrite.push(providerMode)
    return send(...args)
  })
  return { controls, setPermissionMode, policiesAtWrite, mode: () => providerMode }
}

async function loseAskReply() {
  await expect(pick('ask')).rejects.toThrow('timed out')
  expect(store.getRecord(SESSION)?.options?.permissionMode).toBe('bypass')
  expect(adapter['sessions'].get(SESSION)?.appliedPermissionMode).toBeUndefined()
}

async function sendMessage() {
  const body = hostTestMessage('send after choosing Ask')
  const result = await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body }),
    body
  })
  expect(result).toMatchObject({ ok: true })
  return result
}

it('serializes held reconciliation and Ask replies, then writes under saved and displayed Ask', async () => {
  const held = holdControls()
  await loseAskReply()
  const result = await sendMessage()
  await vi.waitFor(() =>
    expect(held.controls.map((control) => control.mode)).toEqual(['bypassPermissions'])
  )
  const optionWrite = vi.spyOn(adapter, 'setOption')
  const picked = pick('ask')
  await vi.waitFor(() => expect(optionWrite).toHaveBeenCalledOnce())
  // A pending choice owns the next operation; preparation cannot restate the older saved intent.
  expect(held.setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
    'default',
    'bypassPermissions'
  ])
  expect(claude.connections[0].sent).toEqual([])
  held.controls[0].reply()
  await vi.waitFor(() =>
    expect(held.controls.map((control) => control.mode)).toEqual(['bypassPermissions', 'default'])
  )
  expect(claude.connections[0].sent).toEqual([])
  held.controls[1].reply()
  expect(await picked).toMatchObject({ ok: true, value: { options: { permissionMode: 'ask' } } })
  await vi.waitFor(() => expect(claude.connections[0].sent).toHaveLength(1))
  expect(held.setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
    'default',
    'bypassPermissions',
    'default'
  ])
  expect(store.getRecord(SESSION)?.options?.permissionMode).toBe('ask')
  expect((await host.readOptions(SESSION)).permissionModes?.current).toBe('ask')
  expect(adapter['sessions'].get(SESSION)?.appliedPermissionMode).toBe('ask')
  expect(held.mode()).toBe('default')
  expect(held.policiesAtWrite).toEqual(['default'])
  if (!result.ok) {
    throw new Error('send refused')
  }
  expect(
    (await host.journalSnapshot(SESSION)).submissions.find(
      (entry) => entry.clientMessageId === result.value.clientMessageId
    )
  ).toMatchObject({ dispatchState: 'pending' })
})

it('Stop cancels reconciliation and a waiting permission write without either reply', async () => {
  const held = holdControls()
  await loseAskReply()
  await sendMessage()
  await vi.waitFor(() => expect(held.controls).toHaveLength(1))
  const optionWrite = vi.spyOn(adapter, 'setOption')
  const picked = pick('ask')
  const cancelled = expect(picked).rejects.toThrow('stopped while starting')
  await vi.waitFor(() => expect(optionWrite).toHaveBeenCalledOnce())
  const stopped = await host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
  expect(stopped).toMatchObject({ ok: true, value: { cancelled: true } })
  await cancelled
  expect(claude.connections[0].sent).toEqual([])
  held.controls[0].reply()
  await vi.waitFor(() => expect(held.setPermissionMode).toHaveBeenCalledTimes(2))
  expect(store.getRecord(SESSION)?.options?.permissionMode).toBe('bypass')
})

it.each([false, true])(
  'persists and publishes Ask to every client after an unsupported model switch (lost reply %s)',
  async (lostReply) => {
    claude.routes.list_models = () => [{ value: 'unsupported' }]
    await pick('auto')
    const events: AgentSessionSubscribeEvent[][] = [[], []]
    for (const [index, received] of events.entries()) {
      await host.subscribe({
        id: String(index),
        sessionId: SESSION,
        emit: (event) => received.push(event)
      })
    }
    const control = vi.spyOn(claude.connections[0], 'setPermissionMode')
    if (lostReply) {
      control.mockRejectedValueOnce(new ClaudeControlRequestTimeoutError('set_permission_mode'))
    }
    const previousRevision = store.permissionRevision(SESSION)
    const fields = { key: 'model', value: 'unsupported' }
    expect(
      await host.setOption(CALLER, {
        envelope: envelope('agentSession.setOption', fields),
        ...fields
      })
    ).toMatchObject({
      ok: true,
      value: {
        options: { model: 'unsupported', permissionMode: 'ask' },
        permissionFact: { mode: 'ask', revision: previousRevision + 1 }
      }
    })
    expect(store.getRecord(SESSION)?.options?.permissionMode).toBe('ask')
    expect((await host.readOptions(SESSION)).permissionModes).toMatchObject({
      current: 'ask',
      supported: ['ask', 'accept-edits', 'bypass'],
      revision: previousRevision + 1
    })
    for (const received of events) {
      expect(received.at(-1)).toMatchObject({
        permissionMode: 'ask',
        permissionRevision: previousRevision + 1
      })
    }
    await sendMessage()
    await vi.waitFor(() => expect(claude.connections[0].sent).toHaveLength(1))
    expect(adapter['sessions'].get(SESSION)?.appliedPermissionMode).toBe('ask')
    expect(control.mock.calls.map(([mode]) => mode)).toEqual(
      lostReply ? ['default', 'default'] : ['default']
    )
  }
)

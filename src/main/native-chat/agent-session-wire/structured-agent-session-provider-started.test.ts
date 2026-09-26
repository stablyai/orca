// A publish-first create proves nothing about the model until Claude answers startup. The record
// must never hold the catalog's default in the meantime: an owner handoff or a reopen would
// replay it as a `set_model` and silently move a user whose CLI default is not Sonnet.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
const INIT_DELAY_MS = 40

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let lifecycle: Promise<void>[]
let statuses: AgentSessionStatusEvent[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-provider-started-'))
  resetHostTestOperationIds()
  lifecycle = []
  statuses = []
  const claude = fakeClaude({ initDelayMs: INIT_DELAY_MS, initModel: 'claude-opus-9' })
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      // A session that already minted its provider handle resumes it, as the real launch does.
      resumesTranscript: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0,
      continuesChain: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0
    }),
    // The runtime's own mapping, so this test drives the same lifecycle path production does.
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    // The production router is what declares create support; the bare adapter only knows locations.
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
  host.subscribeStatus({ id: 'status-1', emit: (event) => statuses.push(event) })
})

afterEach(async () => {
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function claudeParams() {
  return hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
}

function lastPhase(): string | undefined {
  const last = statuses.findLast((event) => event.type === 'status')
  return last?.type === 'status' ? last.session.hostExecutionPhase : undefined
}

describe('a publish-first Claude create whose init is slow', () => {
  it('never persists the catalog default, and persists the reported model once started', async () => {
    await expect(host.attach(CALLER, claudeParams())).resolves.toMatchObject({ ok: true })

    // Published, not yet answering: the record holds no model rather than a guessed one.
    expect(store.getRecord(SESSION)?.options?.model).toBeUndefined()
    expect(lastPhase()).toBe('starting')

    await adapter.drainStartup(SESSION)
    await Promise.all(lifecycle)

    expect(store.getRecord(SESSION)?.options?.model).toBe('claude-opus-9')
    expect(lastPhase()).toBe('ready')
  })

  it('keeps the saved model as intent while starting, then confirms what the child runs', async () => {
    const params = claudeParams()
    await expect(
      host.attach(CALLER, { ...params, options: { model: 'opus' } })
    ).resolves.toMatchObject({ ok: true })
    expect(store.getRecord(SESSION)?.options?.model).toBe('opus')

    await adapter.drainStartup(SESSION)
    await Promise.all(lifecycle)

    expect(store.getRecord(SESSION)?.options?.model).toBe('opus')
    expect(lastPhase()).toBe('ready')
  })

  it('keeps the picked model across a resume whose new child starts on its own default', async () => {
    const params = claudeParams()
    await host.attach(CALLER, { ...params, options: { model: 'opus' } })
    await adapter.drainStartup(SESSION)
    await Promise.all(lifecycle)
    await host.close(SESSION)
    const releasedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0

    // Reopening the chat: the surface's first hold resumes the session.
    await host.hold(SESSION, 'chat-1')
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBeGreaterThan(releasedFence)
    // The new child's init reports its CLI default; the saved pick is restored over it.
    expect(store.getRecord(SESSION)?.options?.model).toBe('opus')
    expect(lastPhase()).toBe('starting')

    await adapter.drainStartup(SESSION)
    await Promise.all(lifecycle)

    expect(store.getRecord(SESSION)?.options?.model).toBe('opus')
    expect(lastPhase()).toBe('ready')
  })
})

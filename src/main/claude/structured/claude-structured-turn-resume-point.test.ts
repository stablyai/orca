import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrackedJournalOpener } from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { reviseAgentSessionProviderResumePoint } from '../../runtime/agent-session/ownership/agent-session-provider-handle-transition'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type {
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  tick
} from './claude-structured-session-test-support'
import { claudeStartupSettled } from './claude-structured-startup-settled-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

const FENCE = 7
const journals = createTrackedJournalOpener()
const cleanups: (() => Promise<void>)[] = []

function liveRecord(): AgentSessionRecord {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({ runtimeKind: 'native', runtimeFence: FENCE })
  )
  return {
    ...record,
    location: { ...record.location, executionHostId: LOCAL_EXECUTION_HOST_ID },
    providerHandleChain: [
      {
        linkId: 'created-link',
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 500,
        handle: claudeProviderHandle(PROVIDER_SESSION_ID, null)
      },
      {
        linkId: 'published-link',
        origin: 'resumed',
        mintedAtFence: FENCE,
        observedAt: 1_000,
        handle: claudeProviderHandle(PROVIDER_SESSION_ID, 'resumed-at')
      }
    ]
  }
}

async function liveOwner(
  persistResumePoint?: ClaudeStructuredSessionAdapterDeps['persistResumePoint'],
  options: {
    missingTranscript?: boolean
    beforeOpen?: (frame: (message: Record<string, unknown>) => void) => void
    resumeLeafUuid?: string | null
    resumesTranscript?: boolean
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-leaf-'))
  const claudeConfigDir = join(root, 'claude-home')
  const projects = join(claudeConfigDir, 'projects', '-work-repo')
  await mkdir(projects, { recursive: true })
  const transcript = join(projects, `${PROVIDER_SESSION_ID}.jsonl`)
  if (!options.missingTranscript) {
    await writeFile(
      transcript,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'resumed-at',
        sessionId: PROVIDER_SESSION_ID,
        message: { role: 'assistant', content: [] }
      })}\n`
    )
  }
  const journal = await journals.open({ identity: identityFor(), stateDirectory: root })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: FENCE, publish: () => {} })
  const store = { record: liveRecord() }
  const claude = fakeClaude()
  const events: ClaudeStructuredSessionEvent[] = []
  const persistedHandles: unknown[] = []
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: { resume: PROVIDER_SESSION_ID },
      cwd: '/work/repo',
      claudeConfigDir,
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: options.resumeLeafUuid === undefined ? 'resumed-at' : options.resumeLeafUuid,
      resumesTranscript: options.resumesTranscript ?? true,
      cliFlag: async () => 'supported' as const,
      continuesChain: true
    }),
    onEvent: (event) => events.push(event),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    persistHandle: async (handle) => {
      persistedHandles.push(handle)
    },
    persistResumePoint:
      persistResumePoint ??
      (async ({ providerSessionId, leafUuid, fence }) => {
        store.record = reviseAgentSessionProviderResumePoint({
          record: store.record,
          fence,
          handle: claudeProviderHandle(providerSessionId, leafUuid),
          now: 2_000
        })
      })
  })
  await adapter.acquire({
    identity: identityFor(),
    fence: FENCE,
    spawnToken: 'spawn-7',
    events: deferred.sink
  })
  const frame = (message: Record<string, unknown>) =>
    claude.connections.at(-1)!.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
  options.beforeOpen?.(frame)
  await claudeStartupSettled(adapter, 'session-1')
  cleanups.push(async () => {
    await adapter.closeAll()
    deferred.close()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  const turn = async (userUuid: string, assistantUuid: string) => {
    frame({
      type: 'user',
      uuid: userUuid,
      parent_tool_use_id: null,
      message: { role: 'user', content: 'ask' }
    })
    frame({
      type: 'assistant',
      uuid: assistantUuid,
      parent_tool_use_id: null,
      message: { id: assistantUuid, role: 'assistant', content: [{ type: 'text', text: 'answer' }] }
    })
    frame({ type: 'system', subtype: 'stop_hook_summary', uuid: `${assistantUuid}-hook` })
    frame({ type: 'result', subtype: 'success', uuid: `${assistantUuid}-result` })
    await tick()
  }
  return {
    adapter,
    claude,
    store,
    events,
    persistedHandles,
    frame,
    turn,
    deferred,
    journal,
    transcript
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  vi.restoreAllMocks()
})

describe('Claude durable resume point at turn end', () => {
  it('re-derives missed suffix coverage on the next acquisition before advancing', async () => {
    const { adapter, store, turn, transcript, journal, deferred } = await liveOwner(undefined, {
      missingTranscript: true
    })
    await turn('u1', 'a1')
    await adapter.closeSession('session-1')
    await writeFile(
      transcript,
      [
        {
          type: 'assistant',
          uuid: 'resumed-at',
          sessionId: PROVIDER_SESSION_ID,
          message: { role: 'assistant', content: [] }
        },
        {
          type: 'assistant',
          uuid: 'outside',
          parentUuid: 'resumed-at',
          sessionId: PROVIDER_SESSION_ID,
          message: { role: 'assistant', content: [{ type: 'text', text: 'outside reply' }] }
        }
      ]
        .map((row) => `${JSON.stringify(row)}\n`)
        .join('')
    )
    await adapter.acquire({
      identity: identityFor(),
      fence: FENCE,
      spawnToken: 'spawn-8',
      events: deferred.sink
    })
    await claudeStartupSettled(adapter, 'session-1')
    expect(
      journal
        .snapshot()
        .items.some(
          (item) =>
            item.body.kind === 'message' &&
            item.body.blocks.some(
              (block) => block.type === 'text' && block.text === 'outside reply'
            )
        )
    ).toBe(true)
    expect(store.record.providerHandleChain.at(-1)?.handle).toMatchObject({
      resumeCursor: 'resumed-at'
    })
    await turn('u2', 'a2')
    expect(store.record.providerHandleChain.at(-1)?.handle).toMatchObject({ resumeCursor: 'a2' })
  })
})

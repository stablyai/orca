import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  type FakeConnection,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

// Serialized delivery can take over a second on loaded runners.
function eventually(assertion: () => unknown): Promise<unknown> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

const CALLER = { callerKey: 'client-1' }
const SURFACE = 'desktop-chat:1'
const LAUNCH_FAILURE =
  'claude stream-json exited (code 1): qa-shim: simulated claude launch failure'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let claude: ReturnType<typeof fakeClaude>
let lifecycle: Promise<void>[]
type OpenEntry = {
  connection: FakeConnection
  sessionId: string
  fence: number
  generation: string
  opened: Promise<unknown>
}
let entries: OpenEntry[]
let opens: Promise<unknown>[]
let changed: ReturnType<typeof Promise.withResolvers<void>>
let firstFailure: ReturnType<typeof Promise.withResolvers<void>>
let driver: Promise<void> | undefined
let stopped: boolean

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-view-start-after-failed-start-'))
  resetHostTestOperationIds()
  lifecycle = []
  entries = []
  opens = []
  changed = Promise.withResolvers<void>()
  firstFailure = Promise.withResolvers<void>()
  driver = undefined
  stopped = false
  claude = fakeClaude({ holdInit: true })
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0,
      cliFlag: async () => 'supported' as const,
      continuesChain: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0
    }),
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
  const open = adapter.open.bind(adapter)
  adapter.open = (request) => {
    const session = adapter['sessions'].get(request.sessionId)
    const connection = claude.connections.find((candidate) => candidate === session?.connection)
    if (
      !session ||
      !connection ||
      session.acquisitionGeneration !== request.acquisitionGeneration
    ) {
      throw new Error('open entry must identify the acquired connection generation')
    }
    const opened = open(request)
    void opened.catch(() => {})
    opens.push(opened)
    entries.push({
      connection,
      sessionId: request.sessionId,
      fence: request.fence,
      generation: request.acquisitionGeneration,
      opened
    })
    changed.resolve()
    return opened
  }
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${claude.connections.length + 1}`,
    now: () => NOW
  })
})

afterEach(async () => {
  host.stopDelivery()
  stopped = true
  firstFailure.resolve()
  changed.resolve()
  claude.dispose()
  await Promise.allSettled(driver ? [driver] : [])
  await Promise.allSettled(opens)
  await adapter.closeAll()
  await Promise.all(lifecycle)
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

async function driveFailures(): Promise<void> {
  for (let attempt = 0; attempt < 6 && !stopped; attempt++) {
    while (entries.length === 0 && !stopped) {
      await changed.promise
      changed = Promise.withResolvers<void>()
    }
    const entry = entries.shift()
    if (!entry || stopped) {
      return
    }
    if (attempt === 0) {
      await firstFailure.promise
    }
    if (stopped) {
      return
    }
    expect(host['sessions'].get(entry.sessionId)?.child).toMatchObject({
      phase: 'starting',
      fence: entry.fence,
      generation: entry.generation
    })
    expect(store.getRecord(entry.sessionId)?.lease).toMatchObject({
      claimStatus: 'live',
      ownerProcess: { pid: entry.connection.pid }
    })
    entry.connection.closed = true
    entry.connection.handlers.onExit?.(new Error(LAUNCH_FAILURE))
    entry.connection.initialization.reject(new Error('Query closed before response received'))
    await entry.opened.catch(() => {})
  }
}

async function settleExits(): Promise<void> {
  await eventually(async () => {
    await adapter.drainObservedExits()
    await Promise.all(lifecycle)
    expect((await host.journalSnapshot(SESSION)).items.length).toBeGreaterThan(0)
  })
  await Promise.all(lifecycle)
}

function view(id: string): Promise<() => void> {
  return host.subscribe({ id, sessionId: SESSION, emit: () => undefined })
}

async function timeline(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'message'
      ? ['message']
      : item.body.kind === 'status' && item.body.tone === 'error'
        ? [item.body.text]
        : []
  )
}

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  expect(sent).toMatchObject({ ok: true })
  return sent.ok ? sent.value.clientMessageId : ''
}

describe('a fresh chat whose Claude start fails', () => {
  it.each([
    ['after the create already died', false],
    ['while the create is still starting', true]
  ] as const)(
    'starts once for the open and retries a send five times, one final row each, when the view binds %s',
    async (_when, createStillStarting) => {
      driver = driveFailures()
      void driver.catch(() => {})
      await expect(
        host.attach(
          CALLER,
          hostTestAttachParams(null, {
            provider: 'claude',
            agent: 'claude',
            accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
            providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
          })
        )
      ).resolves.toMatchObject({ ok: true })
      if (!createStillStarting) {
        firstFailure.resolve()
        await settleExits()
      }
      const unsubscribe = await view(SURFACE)
      await view('desktop-chat:2')
      if (createStillStarting) {
        expect(await timeline()).toEqual([])
        firstFailure.resolve()
      }
      await settleExits()
      const startFailure =
        'Claude stopped before it finished starting. Send your message to try again.'
      expect(claude.connections).toHaveLength(1)
      expect(await timeline()).toEqual([startFailure])

      const sent = await send('reply with exactly: alpha')
      await eventually(async () =>
        expect(
          (await host.journalSnapshot(SESSION)).submissions.find((s) => s.clientMessageId === sent)
        ).toMatchObject({ dispatchState: 'rejected', reason: startFailure })
      )
      await settleExits()
      await driver
      expect(claude.connections).toHaveLength(6)
      expect(await timeline()).toEqual([startFailure, 'message', startFailure])

      unsubscribe()
      await view(SURFACE)
      await settleExits()
      expect(claude.connections).toHaveLength(6)
      expect(await timeline()).toEqual([startFailure, 'message', startFailure])
    }
  )
})

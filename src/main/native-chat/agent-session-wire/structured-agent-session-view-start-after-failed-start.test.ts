// A Claude chat whose CLI exits before it finishes starting leaves one red row per start. A view
// opening, or coming back to, a chat whose last start failed used to start the CLI again, so every
// look at the chat added an identical row. Only a send retries a failed start: it is the user asking.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
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
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

/** Delivery runs on its own serialized steps; under a loaded runner they take more than a second. */
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
/** Every initialize waits on it: a start that must outlast a step does not race a timer. */
let initGate: Promise<void>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-view-start-after-failed-start-'))
  resetHostTestOperationIds()
  lifecycle = []
  initGate = Promise.resolve()
  // Every start spawns, is published, and exits before it answers initialize.
  claude = fakeClaude({ initDelayMs: 20, exitBeforeInit: LAUNCH_FAILURE })
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0,
      continuesChain: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0
    }),
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    openConnection: async (launch, handlers) => {
      const connection = await claude.openConnection(launch, handlers)
      const initialize = connection.initializationResult
      return Object.assign(connection, {
        initializationResult: async () => {
          await initGate
          return initialize()
        }
      })
    },
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${claude.connections.length + 1}`,
    now: () => NOW
  })
})

afterEach(async () => {
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

/** Waits until the adapter has published every exit it saw and the host settled each one. */
async function settleExits(): Promise<void> {
  await eventually(async () => {
    await adapter.drainObservedExits()
    await Promise.all(lifecycle)
    expect((await host.journalSnapshot(SESSION)).items.length).toBeGreaterThan(0)
  })
  await Promise.all(lifecycle)
}

/** A view of the chat: a subscription, which reads the chat and starts nothing. */
function view(id: string): Promise<() => void> {
  return host.subscribe({ id, sessionId: SESSION, emit: () => undefined })
}

/** The chat as it renders: the user's messages and the error rows, in journal order. */
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
  // QA saw three failed starts from opening the chat alone: the create's, and the view's.
  it.each([
    ['after the create already died', false],
    ['while the create is still starting', true]
  ] as const)(
    'starts once for the open and once for a send, one row each, when the view binds %s',
    async (_when, createStillStarting) => {
      // Released only once the views bound, so no runner is slow enough to let the create die first.
      let releaseCreate = (): void => {}
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      if (!createStillStarting) {
        releaseCreate()
      }
      initGate = createGate
      claude = fakeClaude({ exitBeforeInit: LAUNCH_FAILURE })
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
        await settleExits()
      }
      // Two surfaces bind, as a pane and a second window do.
      const unsubscribe = await view(SURFACE)
      await view('desktop-chat:2')
      if (createStillStarting) {
        // The views bound to the create's child itself, before it exited.
        expect(await timeline()).toEqual([])
        releaseCreate()
      }
      await settleExits()
      // The row says the provider stopped; its stderr stays out of the sentence.
      const startFailure =
        'Claude stopped before it finished starting. Send your message to try again.'
      // Opening the chat: the create's start, once, and its row.
      expect(claude.connections).toHaveLength(1)
      expect(await timeline()).toEqual([startFailure])

      const sent = await send('reply with exactly: alpha')
      await eventually(async () =>
        expect(
          (await host.journalSnapshot(SESSION)).submissions.find((s) => s.clientMessageId === sent)
        ).toMatchObject({ dispatchState: 'rejected', reason: startFailure })
      )
      await settleExits()
      // The send's own start, once, and one row for it below the message.
      expect(claude.connections).toHaveLength(2)
      expect(await timeline()).toEqual([startFailure, 'message', startFailure])

      // Switching away and back re-subscribes; it starts nothing and adds no row.
      unsubscribe()
      await view(SURFACE)
      await settleExits()
      expect(claude.connections).toHaveLength(2)
      expect(await timeline()).toEqual([startFailure, 'message', startFailure])
    }
  )
})

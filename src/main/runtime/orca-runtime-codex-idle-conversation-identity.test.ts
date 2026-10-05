// STA-7370: on a headless host a Codex pane that finished its turn and sits idle under its
// neutral `<thread> | <project>` title must still give a cold phone the pane's conversation,
// driven here through real hook HTTP posts, real OSC titles and the real completed-hook recovery.
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installHookStatusSessionTabsRepublish } from '../agent-hooks/hook-status-session-tabs-republish'
import { AgentHookServer } from '../agent-hooks/server'
import { buildBody, PANE, postHookEvent } from '../agent-hooks/server.test-fixtures'
import { readNativeChatTranscriptTail } from '../native-chat/transcript-tail-reader'
import { normalizeAgentProviderSession } from '../../shared/agent-session-resume'
import { TERMINAL_CONVERSATION_IDENTITY_CLIENT_CAPABILITY } from '../../shared/protocol-version'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { selectTerminalConversation } from '../../shared/terminal-conversation-identity'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'
import type { RpcRequest, RpcResponse } from './rpc/core'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const WORKTREE_ID = 'wt-1'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = 'pty-agent'
const SESSION_ID = 'ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31'
const NEXT_SESSION_ID = '5d0c9e3a-7b1f-4c2a-9e8d-3f6b2a1c4d5e'
const NEUTRAL_TITLE = 'Say hi | my-repo'
const THIRTY_ONE_MINUTES_MS = 31 * 60_000
const QUESTION = JSON.stringify({
  questions: [
    {
      question: 'Apply the patch?',
      header: 'Patch',
      multiSelect: false,
      options: [{ label: 'Yes' }, { label: 'No' }]
    }
  ]
})

let cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.toReversed()) {
    await cleanup()
  }
  cleanups = []
})

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function writeCodexRollout(sessionId = SESSION_ID): Promise<string> {
  const filePath = join(await tempDir('orca-codex-idle-identity-'), 'rollout.jsonl')
  const records = [
    { timestamp: '2026-10-04T10:00:00.000Z', type: 'session_meta', payload: { id: sessionId } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Say hi' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Hi there' } }
  ]
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n'))
  return filePath
}

type Presence = 'unverifiable' | null

class InspectableRuntime extends OrcaRuntimeService {
  worktreeId = WORKTREE_ID

  ptyRecord(ptyId: string): RuntimePtyWorktreeRecord | undefined {
    return this.ptysById.get(ptyId)
  }

  resetProviderGeneration(ptyId: string): void {
    this.resetTrackedTerminalStateForProviderGeneration(ptyId)
  }

  /** The launch record an Orca launch into this PTY writes, before its agent reports. */
  recordLaunch(ptyId: string, agent: 'codex'): void {
    const pty = this.ptysById.get(ptyId)
    if (pty) {
      pty.launchAgent = agent
    }
  }

  protected override async resolveTerminalWorkspaceLaunchScope(): Promise<TerminalWorkspaceLaunchScope> {
    return {
      id: this.worktreeId,
      path: '/repo/app',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    }
  }
}

type Pane = {
  runtime: InspectableRuntime
  store: () => AgentHookServer
  /** Stop the store and start a fresh one on the same disk state, as a host restart does. */
  restartStore: () => Promise<void>
  postHooks: (sessionId: string, events: string[], transcriptPath?: string) => Promise<void>
  observeTitle: (title: string) => void
  /** Change the process the next foreground read returns. */
  setForeground: (process: string | null) => void
}

async function createPane(args: {
  presence: Presence
  agent?: 'codex' | 'claude'
  /** False for an agent the user started by hand: no launch record. */
  launched?: boolean
  /** The agent Orca launched the pane as, when the user then runs `agent` by hand. */
  launchedAs?: 'codex' | 'claude'
  /** The recognized foreground process; null when the read is unavailable. */
  foreground?: string | null
  worktreeId?: string
}): Promise<Pane> {
  const agent = args.agent ?? 'codex'
  let foreground = args.foreground === undefined ? agent : args.foreground
  const userDataPath = await tempDir('orca-codex-idle-store-')
  let store = new AgentHookServer()
  await store.start({ env: 'production', userDataPath })
  cleanups.push(() => store.stop())
  const runtime = new InspectableRuntime(null, undefined, {
    onTerminalAgentStatus: (event) => store.ingestTerminalStatus(event),
    getAgentStatusSnapshot: () =>
      store.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
    getAgentProviderSessionSnapshot: () => store.getStatusSnapshot(),
    getAgentProviderSessionRowsForPane: (paneKey) => store.getStatusSnapshotForPane(paneKey),
    getAgentConversationForPane: (paneKey, terminalHandle) =>
      store.getConversationIdentityForPane(paneKey, terminalHandle),
    reconcileAgentStatusForEndedProcess: (paneKeys) =>
      store.reconcileEndedProcessForPaneKeys(paneKeys),
    // Why: real hosts with no live-process verdict take the legacy completed-hook recovery.
    ...(args.presence ? { checkHookAgentPresence: async () => args.presence } : {})
  })
  runtime.worktreeId = args.worktreeId ?? WORKTREE_ID
  let detachRepublish = installHookStatusSessionTabsRepublish(store, () => runtime)
  cleanups.push(() => detachRepublish())
  // Why: as `orca serve` does at launch; the aggregate census waits for this publication.
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => foreground
  })
  await runtime.createTerminal(`id:${runtime.worktreeId}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    ...(args.launched === false ? {} : { launchAgent: args.launchedAs ?? agent }),
    title: 'Terminal'
  })
  return {
    runtime,
    store: () => store,
    restartStore: async () => {
      store.flushStatusPersistSync()
      detachRepublish()
      store.stop()
      store = new AgentHookServer()
      await store.start({ env: 'production', userDataPath })
      detachRepublish = installHookStatusSessionTabsRepublish(store, () => runtime)
    },
    postHooks: async (sessionId, events, transcriptPath) => {
      for (const event of events) {
        const response = await postHookEvent(
          store,
          buildBody({
            hook_event_name: event,
            session_id: sessionId,
            ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
            ...(event === 'UserPromptSubmit' ? { prompt: 'Say hi' } : {})
          }),
          `/hook/${agent}`
        )
        expect(response.status).toBe(204)
      }
    },
    observeTitle: (title) => {
      runtime.onPtyData(PTY_ID, `\x1b]0;${title}\x07`, Date.now())
    },
    setForeground: (process) => {
      foreground = process
    }
  }
}

/** A finished Codex turn: hooks, then the spinner settling onto the neutral thread title. */
async function finishCodexTurn(pane: Pane, sessionId: string): Promise<string> {
  const transcriptPath = await writeCodexRollout(sessionId)
  await pane.postHooks(sessionId, ['SessionStart', 'UserPromptSubmit', 'Stop'], transcriptPath)
  pane.observeTitle(`⠋ ${NEUTRAL_TITLE}`)
  pane.observeTitle(NEUTRAL_TITLE)
  // Precondition: the real completed-hook recovery restored Codex idle under the neutral title.
  await vi.waitFor(() => expect(pane.runtime.ptyRecord(PTY_ID)?.lastAgentStatus).toBe('idle'))
  return transcriptPath
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: `req-${method}`, authToken: 'tok', method, params }
}

async function dispatchFrames(
  runtime: OrcaRuntimeService,
  method: string,
  clientKind: 'mobile' | 'runtime',
  clientCapabilities?: readonly string[]
): Promise<RpcResponse[]> {
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const frames: RpcResponse[] = []
  const worktreeId = runtime instanceof InspectableRuntime ? runtime.worktreeId : WORKTREE_ID
  await dispatcher.dispatchStreaming(
    makeRequest(method, { worktree: `id:${worktreeId}` }),
    (raw) => frames.push(JSON.parse(raw)),
    { clientKind, connectionId: `conn-${clientKind}`, clientCapabilities }
  )
  return frames
}

function terminalTabOf(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== 'object' || !('tabs' in result) || !Array.isArray(result.tabs)) {
    return undefined
  }
  return result.tabs.find((tab) => tab?.type === 'terminal')
}

function firstTerminalTab(frame: RpcResponse | undefined): Record<string, unknown> | undefined {
  return terminalTabOf(frame?.ok ? frame.result : null)
}

/** The pane's tab in an aggregate (`listAll` result or `subscribeAll` census) frame. */
function aggregateTerminalTab(frame: RpcResponse | undefined): Record<string, unknown> | undefined {
  const result = frame?.ok ? frame.result : null
  if (
    !result ||
    typeof result !== 'object' ||
    !('snapshots' in result) ||
    !Array.isArray(result.snapshots)
  ) {
    return undefined
  }
  return terminalTabOf(result.snapshots.find((entry) => entry?.worktree === WORKTREE_ID))
}

async function listTab(
  runtime: OrcaRuntimeService,
  clientKind: 'mobile' | 'runtime'
): Promise<Record<string, unknown> | undefined> {
  const tab = firstTerminalTab((await dispatchFrames(runtime, 'session.tabs.list', clientKind))[0])
  expect(tab).toMatchObject({ type: 'terminal' })
  return tab
}

function advanceClock(byMs: number): void {
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + byMs)
}

describe('idle Codex pane conversation identity on a headless host', () => {
  it.each<Presence>(['unverifiable', null])(
    'gives a cold phone the session under the neutral idle title (presence %s)',
    async (presence) => {
      const pane = await createPane({ presence })
      const transcriptPath = await finishCodexTurn(pane, SESSION_ID)
      const pty = pane.runtime.ptyRecord(PTY_ID)
      expect(pty?.connected).toBe(true)
      expect(pty?.lastOscTitle).toBe(NEUTRAL_TITLE)
      const row = pane.store().getStatusSnapshot()[0]
      expect(row).toMatchObject({
        state: 'done',
        providerSession: { id: SESSION_ID, transcriptPath }
      })
      expect(row?.restoredUnconfirmed).not.toBe(true)
      expect(row?.providerSessionOnly).not.toBe(true)

      const mobileList = await listTab(pane.runtime, 'mobile')
      expect(mobileList).toMatchObject({ launchAgent: 'codex' })
      expect(mobileList?.agentStatus).toMatchObject({
        state: 'done',
        sessionBoundary: true,
        prompt: '',
        agentType: 'codex',
        providerSession: { id: SESSION_ID, transcriptPath }
      })
      const mobileSubscribe = firstTerminalTab(
        (await dispatchFrames(pane.runtime, 'session.tabs.subscribe', 'mobile'))[0]
      )
      expect(mobileSubscribe?.agentStatus).toEqual(mobileList?.agentStatus)

      expect(await listTab(pane.runtime, 'runtime')).not.toHaveProperty('agentStatus')
    }
  )

  it('gives a cold phone the session through the aggregate listAll and subscribeAll census', async () => {
    const pane = await createPane({ presence: null })
    const transcriptPath = await finishCodexTurn(pane, SESSION_ID)
    const expected = {
      state: 'done',
      sessionBoundary: true,
      agentType: 'codex',
      providerSession: { id: SESSION_ID, transcriptPath }
    }

    for (const method of ['session.tabs.listAll', 'session.tabs.subscribeAll']) {
      const mobileFrame = (await dispatchFrames(pane.runtime, method, 'mobile'))[0]
      expect(aggregateTerminalTab(mobileFrame)?.agentStatus).toMatchObject(expected)
      const runtimeTab = aggregateTerminalTab(
        (await dispatchFrames(pane.runtime, method, 'runtime'))[0]
      )
      expect(runtimeTab).toMatchObject({ type: 'terminal' })
      expect(runtimeTab).not.toHaveProperty('agentStatus')
    }
  })

  it('the seeded rollout the identity addresses is readable as the conversation', async () => {
    const transcriptPath = await writeCodexRollout()
    const tail = await readNativeChatTranscriptTail({
      agent: 'codex',
      sessionId: SESSION_ID,
      transcriptPath,
      limit: 40
    })
    expect(tail).toMatchObject({
      messages: [
        { role: 'user', blocks: [{ type: 'text', text: 'Say hi' }] },
        { role: 'assistant', blocks: [{ type: 'text', text: 'Hi there' }] }
      ]
    })
  })

  it('keeps only the addressable identity of an aged remnant across a store restart', async () => {
    const pane = await createPane({ presence: 'unverifiable' })
    const transcriptPath = await finishCodexTurn(pane, SESSION_ID)
    pane.store().dropStatusEntry(PANE)
    expect(pane.store().getStatusSnapshot()).toEqual([
      expect.objectContaining({ providerSessionOnly: true })
    ])
    await pane.restartStore()
    expect(pane.store().getStatusSnapshot()).toEqual([
      expect.objectContaining({ providerSessionOnly: true, providerSession: expect.anything() })
    ])
    advanceClock(THIRTY_ONE_MINUTES_MS)

    const status = (await listTab(pane.runtime, 'mobile'))?.agentStatus
    expect(status).toMatchObject({
      state: 'done',
      sessionBoundary: true,
      agentType: 'codex',
      providerSession: { id: SESSION_ID, transcriptPath }
    })
    for (const field of ['toolName', 'interactivePrompt', 'interrupted', 'turnCompletedAt']) {
      expect(status).not.toHaveProperty(field)
    }
    expect(await listTab(pane.runtime, 'runtime')).not.toHaveProperty('agentStatus')
  })

  it.each([
    ['a provider generation reset', (pane: Pane) => pane.runtime.resetProviderGeneration(PTY_ID)],
    ['a pane retirement', (pane: Pane) => pane.store().retirePaneAuthority(PANE)]
  ])('drops the old identity at once after %s', async (_name, evict) => {
    const pane = await createPane({ presence: 'unverifiable' })
    await finishCodexTurn(pane, SESSION_ID)
    expect((await listTab(pane.runtime, 'mobile'))?.agentStatus).toMatchObject({
      providerSession: { id: SESSION_ID }
    })

    evict(pane)

    expect(await listTab(pane.runtime, 'mobile')).not.toHaveProperty('agentStatus')
    // Why absent, not null: the row is gone, and a gone row says nothing about the pane.
    expect(await listTab(pane.runtime, 'runtime')).not.toHaveProperty('conversationIdentity')
  })

  it('projects only the new session once Codex reopens on the reset pane', async () => {
    const pane = await createPane({ presence: 'unverifiable' })
    await finishCodexTurn(pane, SESSION_ID)
    pane.runtime.resetProviderGeneration(PTY_ID)

    const nextTranscriptPath = await finishCodexTurn(pane, NEXT_SESSION_ID)

    expect((await listTab(pane.runtime, 'mobile'))?.agentStatus).toMatchObject({
      sessionBoundary: true,
      providerSession: { id: NEXT_SESSION_ID, transcriptPath: nextTranscriptPath }
    })
  })

  it('drops the identity when the pane process exits', async () => {
    const pane = await createPane({ presence: 'unverifiable' })
    await finishCodexTurn(pane, SESSION_ID)

    pane.runtime.onPtyExit(PTY_ID, 0)

    const frame = (await dispatchFrames(pane.runtime, 'session.tabs.list', 'mobile'))[0]
    expect(frame?.ok).toBe(true)
    expect(JSON.stringify(frame)).not.toContain(SESSION_ID)
  })

  describe('questions', () => {
    async function askUnderNeutralTitle(pane: Pane): Promise<void> {
      const payload = {
        state: 'waiting',
        prompt: 'Apply?',
        agentType: 'codex',
        interactivePrompt: QUESTION
      }
      pane.runtime.onPtyData(PTY_ID, `\x1b]9999;${JSON.stringify(payload)}\x07`, Date.now())
      pane.observeTitle(NEUTRAL_TITLE)
    }

    it('keeps a current question as live status rather than the identity carrier', async () => {
      const pane = await createPane({ presence: 'unverifiable' })
      await finishCodexTurn(pane, SESSION_ID)
      await askUnderNeutralTitle(pane)

      const status = (await listTab(pane.runtime, 'mobile'))?.agentStatus
      expect(status).toMatchObject({ state: 'waiting', interactivePrompt: QUESTION })
      expect(status).not.toHaveProperty('sessionBoundary')
    })

    it('does not revive an expired question', async () => {
      const pane = await createPane({ presence: 'unverifiable' })
      await finishCodexTurn(pane, SESSION_ID)
      await askUnderNeutralTitle(pane)
      advanceClock(THIRTY_ONE_MINUTES_MS)

      // The OSC question row carries no provider session (an existing store rule), so only
      // the absence of the question is asserted here.
      const tab = await listTab(pane.runtime, 'mobile')
      expect(tab).not.toHaveProperty('agentStatus.interactivePrompt')
      expect(tab).not.toHaveProperty('agentStatus.state', 'waiting')
    })

    it('does not revive a question restored from disk', async () => {
      const pane = await createPane({ presence: 'unverifiable' })
      await finishCodexTurn(pane, SESSION_ID)
      await askUnderNeutralTitle(pane)
      await pane.restartStore()
      expect(pane.store().getStatusSnapshot()[0]?.restoredUnconfirmed).toBe(true)

      const tab = await listTab(pane.runtime, 'mobile')
      expect(tab).not.toHaveProperty('agentStatus.interactivePrompt')
      expect(tab).not.toHaveProperty('agentStatus.state', 'waiting')
    })

    it('does not keep a question a later Stop replaced', async () => {
      const pane = await createPane({ presence: 'unverifiable' })
      await finishCodexTurn(pane, SESSION_ID)
      await askUnderNeutralTitle(pane)
      await pane.postHooks(SESSION_ID, ['Stop'])

      const status = (await listTab(pane.runtime, 'mobile'))?.agentStatus
      expect(status).not.toHaveProperty('interactivePrompt')
      expect(status).toMatchObject({ state: 'done', providerSession: { id: SESSION_ID } })
    })
  })

  it('leaves a Claude pane idle under its glyph title on its existing status path', async () => {
    const pane = await createPane({ presence: 'unverifiable', agent: 'claude' })
    await pane.postHooks(SESSION_ID, ['SessionStart', 'UserPromptSubmit', 'Stop'])
    pane.observeTitle('⠂ Claude Code')
    pane.observeTitle('✳ Claude Code')

    for (const clientKind of ['mobile', 'runtime'] as const) {
      const status = (await listTab(pane.runtime, clientKind))?.agentStatus
      expect(status).toMatchObject({
        state: 'done',
        agentType: 'claude',
        providerSession: { id: SESSION_ID }
      })
      expect(status).not.toHaveProperty('sessionBoundary')
    }
  })
})

describe('the published conversation field on a headless host', () => {
  const FIXTURE_PATH = join(
    __dirname,
    '../../shared/__fixtures__/terminal-conversation-identity-idle-frame.json'
  )

  it('gives a runtime client and a capable phone the field and the offer, with no status', async () => {
    const pane = await createPane({ presence: null })
    const transcriptPath = await finishCodexTurn(pane, SESSION_ID)
    const expected = {
      conversationIdentity: {
        agentType: 'codex',
        providerSession: { key: 'session_id', id: SESSION_ID, transcriptPath },
        source: 'live'
      },
      conversationOfferedWithoutStatus: true
    }
    for (const method of ['session.tabs.list', 'session.tabs.subscribe']) {
      const runtimeTab = firstTerminalTab(
        (await dispatchFrames(pane.runtime, method, 'runtime'))[0]
      )
      expect(runtimeTab).toMatchObject(expected)
      expect(runtimeTab).not.toHaveProperty('agentStatus')
      const capable = firstTerminalTab(
        (
          await dispatchFrames(pane.runtime, method, 'mobile', [
            TERMINAL_CONVERSATION_IDENTITY_CLIENT_CAPABILITY
          ])
        )[0]
      )
      expect(capable).toMatchObject(expected)
      expect(capable).not.toHaveProperty('agentStatus')
      const oldPhone = firstTerminalTab((await dispatchFrames(pane.runtime, method, 'mobile'))[0])
      expect(oldPhone).toMatchObject({
        agentStatus: { state: 'done', sessionBoundary: true, providerSession: { id: SESSION_ID } }
      })
      // Why: a shipped phone reads only the fold; the members would double its frame for nothing.
      expect(oldPhone).not.toHaveProperty('conversationIdentity')
      expect(oldPhone).not.toHaveProperty('conversationOfferedWithoutStatus')
    }
    for (const method of ['session.tabs.listAll', 'session.tabs.subscribeAll']) {
      const runtimeTab = aggregateTerminalTab(
        (await dispatchFrames(pane.runtime, method, 'runtime'))[0]
      )
      expect(runtimeTab).toMatchObject(expected)
      expect(runtimeTab).not.toHaveProperty('agentStatus')
    }
  })

  it('keeps the field through the done -> OSC working window before the next hook', async () => {
    const pane = await createPane({ presence: null })
    const transcriptPath = await finishCodexTurn(pane, SESSION_ID)
    pane.store().ingestTerminalStatus({
      paneKey: PANE,
      payload: { state: 'working', agentType: 'codex', prompt: '' }
    })
    expect(pane.store().getStatusSnapshotForPane(PANE)[0]?.providerSession).toBeUndefined()
    expect(await listTab(pane.runtime, 'runtime')).toMatchObject({
      conversationIdentity: { providerSession: { id: SESSION_ID, transcriptPath } }
    })
  })

  it('publishes exactly the frame the cold-desktop fixture was authored as', async () => {
    const now = 1_791_108_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const pane = await createPane({ presence: null, launched: false })
    const transcriptPath = await finishCodexTurn(pane, SESSION_ID)
    const frame = (await dispatchFrames(pane.runtime, 'session.tabs.list', 'runtime'))[0]
    const result = frame?.ok ? structuredClone(frame.result) : null
    const tab = terminalTabOf(result)
    expect(tab).toBeDefined()
    expect(tab).not.toHaveProperty('launchAgent')
    expect(tab).not.toHaveProperty('agentStatus')
    // Why: only run-specific values differ from the fixture: the epoch, handle and temp path.
    const normalized = JSON.parse(
      JSON.stringify(result)
        .replaceAll(JSON.stringify(transcriptPath), JSON.stringify('/fixture/rollout.jsonl'))
        .replaceAll(JSON.stringify(String(tab?.terminal)), JSON.stringify('terminal-fixture'))
    )
    normalized.publicationEpoch = 'headless:fixture'
    normalized.snapshotVersion = 1
    expect(`${JSON.stringify(normalized, null, 2)}\n`).toBe(readFileSync(FIXTURE_PATH, 'utf8'))
  })

  it('passes a Windows transcript path through opaquely', async () => {
    const pane = await createPane({ presence: null })
    const windowsPath = 'C:\\Users\\me\\.codex\\sessions\\rollout-ac1f.jsonl'
    await pane.postHooks(SESSION_ID, ['SessionStart', 'UserPromptSubmit', 'Stop'], windowsPath)
    pane.observeTitle(`⠋ ${NEUTRAL_TITLE}`)
    pane.observeTitle(NEUTRAL_TITLE)
    await vi.waitFor(() => expect(pane.runtime.ptyRecord(PTY_ID)?.lastAgentStatus).toBe('idle'))
    expect(await listTab(pane.runtime, 'runtime')).toMatchObject({
      conversationIdentity: { providerSession: { id: SESSION_ID, transcriptPath: windowsPath } }
    })
  })

  it('publishes the field for a folder workspace', async () => {
    const pane = await createPane({ presence: null, worktreeId: 'folder:notes' })
    await finishCodexTurn(pane, SESSION_ID)
    expect(await listTab(pane.runtime, 'runtime')).toMatchObject({
      conversationIdentity: { providerSession: { id: SESSION_ID } },
      conversationOfferedWithoutStatus: true
    })
  })

  it('sends no extra frame for five neutral repaints and five same-status OSC refreshes', async () => {
    const pane = await createPane({ presence: null })
    await finishCodexTurn(pane, SESSION_ID)
    const dispatcher = new RpcDispatcher({ runtime: pane.runtime, methods: SESSION_TAB_METHODS })
    const frames: RpcResponse[] = []
    const controller = new AbortController()
    const streaming = dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribe', { worktree: `id:${WORKTREE_ID}` }),
      (raw) => frames.push(JSON.parse(raw)),
      { clientKind: 'runtime', connectionId: 'conn-churn', signal: controller.signal }
    )
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0))
    // Why one round first: the first OSC row is a genuine change (its prompt clears).
    pane.store().ingestTerminalStatus({
      paneKey: PANE,
      payload: { state: 'done', agentType: 'codex', prompt: '' }
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const settled = frames.length
    for (let index = 0; index < 5; index += 1) {
      pane.observeTitle(NEUTRAL_TITLE)
      pane.runtime.onPtyData(PTY_ID, 'output\r\n', Date.now())
      pane.store().ingestTerminalStatus({
        paneKey: PANE,
        payload: { state: 'done', agentType: 'codex', prompt: '' }
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    const identities = frames
      .slice(settled)
      .map((frame) => JSON.stringify(firstTerminalTab(frame)?.conversationIdentity))
    expect(new Set(identities).size).toBeLessThanOrEqual(1)
    expect(frames.length - settled).toBe(0)
    controller.abort()
    await streaming.catch(() => undefined)
  })
})

describe('a pane whose agent changed by hand', () => {
  const capable = [TERMINAL_CONVERSATION_IDENTITY_CLIENT_CAPABILITY]

  /** The status members the shared conversation reader takes, read off a wire tab. */
  function readAgentStatus(tab: Record<string, unknown> | undefined) {
    const status = tab?.agentStatus
    if (!status || typeof status !== 'object') {
      return null
    }
    const providerSession =
      'providerSession' in status ? normalizeAgentProviderSession(status.providerSession) : null
    return {
      ...('agentType' in status && typeof status.agentType === 'string'
        ? { agentType: status.agentType }
        : {}),
      ...(providerSession ? { providerSession } : {})
    }
  }

  async function audiences(runtime: OrcaRuntimeService) {
    const tabOf = async (kind: 'mobile' | 'runtime', caps?: readonly string[]) =>
      firstTerminalTab((await dispatchFrames(runtime, 'session.tabs.list', kind, caps))[0])
    return {
      desktop: await tabOf('runtime'),
      phone: await tabOf('mobile', capable),
      oldPhone: await tabOf('mobile')
    }
  }

  it('gives every client the Codex conversation in a pane Orca launched as Claude', async () => {
    const pane = await createPane({ presence: null, agent: 'codex', launchedAs: 'claude' })
    const transcriptPath = await writeCodexRollout()
    await pane.postHooks(SESSION_ID, ['SessionStart', 'UserPromptSubmit'], transcriptPath)
    pane.observeTitle(`⠋ ${NEUTRAL_TITLE}`)
    const providerSession = { key: 'session_id', id: SESSION_ID, transcriptPath }
    const { desktop, phone, oldPhone } = await audiences(pane.runtime)
    for (const tab of [desktop, phone, oldPhone]) {
      expect(tab).toMatchObject({
        launchAgent: 'claude',
        agentStatus: { state: 'working', agentType: 'codex', providerSession }
      })
    }
    for (const tab of [desktop, phone]) {
      expect(tab?.conversationIdentity).toMatchObject({ agentType: 'codex', providerSession })
      const selection = selectTerminalConversation({
        conversationIdentity: tab?.conversationIdentity,
        conversationOfferedWithoutStatus: tab?.conversationOfferedWithoutStatus,
        agentStatus: readAgentStatus(tab),
        agent: 'codex'
      })
      expect(selection).toMatchObject({ authority: 'address', address: { providerSession } })
    }

    await pane.postHooks(SESSION_ID, ['Stop'], transcriptPath)
    pane.observeTitle(NEUTRAL_TITLE)
    expect((await listTab(pane.runtime, 'runtime'))?.conversationIdentity).toMatchObject({
      agentType: 'codex',
      providerSession
    })
  })

  it("never offers the previous agent's conversation once a session-less agent replaced it", async () => {
    const pane = await createPane({
      presence: null,
      agent: 'claude',
      launched: false,
      foreground: null
    })
    await pane.postHooks(SESSION_ID, ['UserPromptSubmit', 'Stop'], '/r/claude-S.jsonl')
    advanceClock(60_000)
    // The user quit Claude and started Amp by hand; Amp's hooks carry no session id.
    for (const event of ['agent.start', 'agent.end']) {
      const body = buildBody({ hook_event_name: event, prompt: 'Fix it' })
      expect((await postHookEvent(pane.store(), body, '/hook/amp')).status).toBe(204)
    }
    pane.observeTitle(NEUTRAL_TITLE)
    expect(pane.store().getStatusSnapshotForPane(PANE)[0]).toMatchObject({ agentType: 'amp' })
    expect(pane.store().getConversationIdentityForPane(PANE)).toMatchObject({
      facet: { agentType: 'claude', providerSession: { id: SESSION_ID } },
      rowAgent: 'amp'
    })

    for (const aged of [false, true]) {
      if (aged) {
        advanceClock(THIRTY_ONE_MINUTES_MS)
      }
      for (const tab of Object.values(await audiences(pane.runtime))) {
        expect(tab).toMatchObject({ type: 'terminal' })
        expect(tab).not.toHaveProperty('conversationIdentity')
        expect(tab).not.toHaveProperty('conversationOfferedWithoutStatus')
        expect(JSON.stringify(tab)).not.toContain(SESSION_ID)
      }
    }
  })

  describe('after a hand-started Claude leaves the pane', () => {
    async function expectNoConversation(runtime: OrcaRuntimeService): Promise<void> {
      for (const tab of Object.values(await audiences(runtime))) {
        expect(tab).toMatchObject({ type: 'terminal' })
        expect(tab).not.toHaveProperty('conversationIdentity')
        expect(tab).not.toHaveProperty('conversationOfferedWithoutStatus')
      }
    }

    /** Claude, started by hand, reports S and finishes its turn under a neutral title. */
    async function claudeTurn(): Promise<Pane> {
      const pane = await createPane({ presence: null, agent: 'claude', launched: false })
      await pane.postHooks(SESSION_ID, ['UserPromptSubmit', 'Stop'], '/r/claude-S.jsonl')
      pane.observeTitle(NEUTRAL_TITLE)
      await pane.runtime.refreshPtyForegroundAgentFromController(PTY_ID)
      expect(pane.runtime.ptyRecord(PTY_ID)?.foregroundAgent).toBe('claude')
      advanceClock(60_000)
      return pane
    }

    /** The user runs an agent with no hook reports; the host reads it in the foreground. */
    async function startByHand(pane: Pane, process: string | null): Promise<void> {
      pane.setForeground(process)
      pane.observeTitle('Fix it | my-repo')
      await pane.runtime.refreshPtyForegroundAgentFromController(PTY_ID)
      expect(pane.runtime.ptyRecord(PTY_ID)?.foregroundAgent).toBe(process)
    }

    it('keeps offering Claude its own conversation while it stays in the foreground', async () => {
      const pane = await claudeTurn()
      const { desktop, phone } = await audiences(pane.runtime)
      for (const tab of [desktop, phone]) {
        expect(tab?.conversationIdentity).toMatchObject({
          agentType: 'claude',
          providerSession: { id: SESSION_ID }
        })
      }
    })

    it.each([
      {
        exit: 'a certified exit to the shell',
        leave: (store: AgentHookServer) =>
          store.reconcileEndedProcessForPaneKeys([PANE], { preserveResumeIdentity: true })
      },
      { exit: 'a dismissal', leave: (store: AgentHookServer) => store.dropStatusEntry(PANE) }
    ])('never offers its conversation to aider after $exit', async ({ leave }) => {
      const pane = await claudeTurn()
      leave(pane.store())
      expect(pane.store().getConversationIdentityForPane(PANE)).toMatchObject({
        facet: { agentType: 'claude' },
        rowIsRemnant: true
      })
      await startByHand(pane, 'aider')
      await expectNoConversation(pane.runtime)
      advanceClock(THIRTY_ONE_MINUTES_MS)
      await expectNoConversation(pane.runtime)
    })

    it('never offers its conversation to gemini when the exit went unobserved', async () => {
      const pane = await claudeTurn()
      await startByHand(pane, 'gemini')
      expect(pane.store().getConversationIdentityForPane(PANE)).toMatchObject({
        rowAgent: 'claude',
        rowIsRemnant: false
      })
      await expectNoConversation(pane.runtime)
      advanceClock(THIRTY_ONE_MINUTES_MS)
      await expectNoConversation(pane.runtime)
    })

    it('never offers its conversation to a Codex Orca launched there before Codex reports', async () => {
      const pane = await claudeTurn()
      pane.store().dropStatusEntry(PANE)
      await startByHand(pane, null)
      pane.runtime.recordLaunch(PTY_ID, 'codex')
      await expectNoConversation(pane.runtime)
    })
  })
})

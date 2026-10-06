// STA-7370: on a headless host a Codex pane that finished its turn and sits idle under its
// neutral `<thread> | <project>` title must still give a cold phone the pane's conversation,
// driven here through real hook HTTP posts, real OSC titles and the real completed-hook recovery.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installHookStatusSessionTabsRepublish } from '../agent-hooks/hook-status-session-tabs-republish'
import { AgentHookServer } from '../agent-hooks/server'
import { buildBody, PANE, postHookEvent } from '../agent-hooks/server.test-fixtures'
import { readNativeChatTranscriptTail } from '../native-chat/transcript-tail-reader'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
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
  ptyRecord(ptyId: string): RuntimePtyWorktreeRecord | undefined {
    return this.ptysById.get(ptyId)
  }

  resetProviderGeneration(ptyId: string): void {
    this.resetTrackedTerminalStateForProviderGeneration(ptyId)
  }

  protected override async resolveTerminalWorkspaceLaunchScope(): Promise<TerminalWorkspaceLaunchScope> {
    return {
      id: WORKTREE_ID,
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
}

async function createPane(args: { presence: Presence; agent?: 'codex' | 'claude' }): Promise<Pane> {
  const agent = args.agent ?? 'codex'
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
    reconcileAgentStatusForEndedProcess: (paneKeys) =>
      store.reconcileEndedProcessForPaneKeys(paneKeys),
    // Why: real hosts with no live-process verdict take the legacy completed-hook recovery.
    ...(args.presence ? { checkHookAgentPresence: async () => args.presence } : {})
  })
  let detachRepublish = installHookStatusSessionTabsRepublish(store, () => runtime)
  cleanups.push(() => detachRepublish())
  // Why: as `orca serve` does at launch; the aggregate census waits for this publication.
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => agent
  })
  await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: agent,
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
  clientKind: 'mobile' | 'runtime'
): Promise<RpcResponse[]> {
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const frames: RpcResponse[] = []
  await dispatcher.dispatchStreaming(
    makeRequest(method, { worktree: `id:${WORKTREE_ID}` }),
    (raw) => frames.push(JSON.parse(raw)),
    { clientKind, connectionId: `conn-${clientKind}` }
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

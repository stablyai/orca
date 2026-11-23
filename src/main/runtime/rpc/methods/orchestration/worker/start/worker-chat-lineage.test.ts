import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { STRUCTURED_AGENT_RUNTIME_METADATA } from '../../../../../agent-session/installation/structured-agent-runtime-metadata'
import {
  decideWorkerStartMode,
  downgradeWorkerStartModeForHost
} from '../../structured-workers/orchestration-worker-start-mode'
import { BotItemsStore } from '../../../../../../bots/bot-items-store'
import {
  lineageModeForResolvedAgent,
  noteTerminalFallbackOnItem,
  startsInChatLineage
} from './worker-chat-lineage'

const TERMINAL_SETTINGS = { agentDefaultSurface: 'terminal' as const, nativeChatProviders: {} }

describe('a chat-lineage worker start', () => {
  it('never picks a terminal for an agent whose chat can run here, whatever the settings say', () => {
    const agents = STRUCTURED_AGENT_RUNTIME_METADATA.map(({ definition }) => definition.agent)
    expect(agents.length).toBeGreaterThan(20)
    for (const agent of agents.filter((name) => name !== 'hermes')) {
      const settings = { ...TERMINAL_SETTINGS, nativeChatProviders: { [agent]: false } }
      expect(decideWorkerStartMode({ params: { agent }, settings, chatLineage: true }).mode).toBe(
        'structured'
      )
      expect(decideWorkerStartMode({ params: { agent }, settings }).mode).toBe('terminal')
    }
  })

  it('falls back to a terminal with its reason instead of refusing where no chat can run', () => {
    const lead = "Workers started from a persistent agent's home"
    const reused = decideWorkerStartMode({
      params: { agent: 'claude', terminal: 'term_x' },
      settings: TERMINAL_SETTINGS,
      chatLineage: true
    })
    expect(reused).toMatchObject({ mode: 'terminal', reason: 'reused_terminal' })
    expect(reused.detail).toContain(lead)
    const hermes = decideWorkerStartMode({
      params: { agent: 'hermes' },
      settings: TERMINAL_SETTINGS,
      chatLineage: true
    })
    expect(hermes).toMatchObject({ mode: 'terminal', reason: 'chat_cannot_run_orca_commands' })
    const chosen = decideWorkerStartMode({
      params: { agent: 'codex' },
      settings: TERMINAL_SETTINGS,
      chatLineage: true
    })
    const wsl = downgradeWorkerStartModeForHost(chosen, { supported: false, reason: 'wsl' })
    expect(wsl).toMatchObject({ mode: 'terminal', reason: 'wsl_execution_runtime' })
    expect(wsl.detail).toContain(lead)
  })
})

describe('the chat-lineage stamp', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  function start(
    creator: Parameters<OrchestrationDb['createStartingWorkerDispatch']>[0]['creator'],
    extra: { chatLineage?: boolean } = {}
  ): string {
    const task = db.createTask({ spec: 'w', runId: 'run_legacy_local' })
    return db.createStartingWorkerDispatch({
      creator,
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      ...extra
    }).dispatch.id
  }

  function bind(dispatchId: string, handle: string): { kind: 'terminal'; handle: string } {
    db.prepareStartingWorkerAuthority({
      dispatchId,
      handle,
      paneKey: null,
      processIncarnation: null,
      worktreeId: 'wt',
      effects: [],
      setupState: 'not_applicable'
    })
    return { kind: 'terminal', handle }
  }

  it('passes down from a stamped worker to its workers at every depth, and nowhere else', () => {
    const root = bind(start({ kind: 'system' }, { chatLineage: true }), 'term_root')
    expect(db.creatorStartsChatWorkers(root)).toBe(true)
    const child = start(root, { chatLineage: db.creatorStartsChatWorkers(root) })
    const grandchild = bind(child, 'term_child')
    expect(db.creatorStartsChatWorkers(grandchild)).toBe(true)

    const owner = bind(start({ kind: 'system' }), 'term_owner')
    expect(db.creatorStartsChatWorkers(owner)).toBe(false)
    expect(db.creatorStartsChatWorkers({ kind: 'system' })).toBe(false)
  })

  it('starts a lineage from a session in an agent home, from a stamped session creator, and on a repeat', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these calls read only the agent-home list and, without --from, nothing else of the runtime.
    const runtime = {
      bots: { list: () => [{ folderWorkspaceId: 'home-1' }] }
    } as unknown as Parameters<typeof startsInChatLineage>[0]
    const session = (workspaceId: string) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: membership reads only the session's workspace.
      ({ sessionId: 'session-1', workspaceId }) as unknown as Parameters<
        typeof startsInChatLineage
      >[3]
    expect(startsInChatLineage(runtime, db, {}, session('folder:home-1'))).toBe(true)
    expect(startsInChatLineage(runtime, db, {}, session('folder:elsewhere'))).toBe(false)

    const sessionId = '6f1c2a9e-5b7d-4c3e-9a8f-1d2e3f4a5b6c'
    const stamped = start({ kind: 'system' }, { chatLineage: true })
    bind(stamped, `orca_session_id:${sessionId}`)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a well-formed Orca session id.
    const creator = { kind: 'session', orcaSessionId: sessionId } as Parameters<
      OrchestrationDb['creatorStartsChatWorkers']
    >[0]
    expect(db.creatorStartsChatWorkers(creator)).toBe(true)

    const plain = start({ kind: 'system' })
    expect(startsInChatLineage(runtime, db, { retryOf: stamped }, undefined)).toBe(true)
    expect(startsInChatLineage(runtime, db, {}, undefined, stamped)).toBe(true)
    expect(startsInChatLineage(runtime, db, { retryOf: plain }, undefined, stamped)).toBe(true)
    expect(startsInChatLineage(runtime, db, { retryOf: plain }, undefined)).toBe(false)
  })
})

describe('a chat-lineage start that took a terminal', () => {
  it('notes why on its item and refreshes it, but not for a failed start or an explicit --terminal', async () => {
    const store = BotItemsStore.open(':memory:')
    const actor = { kind: 'bot', botId: 'home', chatId: 'chat' } as const
    const itemUid = store.add(
      {
        ownerBotId: 'home',
        chatId: 'chat',
        source: { kind: 'home', title: null },
        title: 'Item',
        status: 'working',
        links: []
      },
      actor
    ).uid
    const changed: string[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the note calls only these store methods.
    const remote = {
      orcaComment: async (...args: Parameters<BotItemsStore['orcaComment']>) =>
        store.orcaComment(...args),
      get: async (uid: string) => store.get(uid)
    } as unknown as ReturnType<
      Parameters<typeof noteTerminalFallbackOnItem>[0]['botItems']['store']
    >
    const runtime = {
      botItems: {
        store: () => remote,
        changed: (items: readonly { uid: string }[]) => changed.push(...items.map((i) => i.uid))
      }
    }
    const receipt = (state: string) => ({
      dispatchId: 'ctx_1',
      state,
      mode: {
        mode: 'terminal',
        detail: 'Workers started from a persistent agent home… started a terminal.'
      }
    })
    const comments = () =>
      store.events(itemUid, 0, 50).filter((event) => event.kind === 'commented')

    await noteTerminalFallbackOnItem(
      runtime,
      { itemUid, chatLineage: true, terminal: 'orca_session_id:x' },
      receipt('ready')
    )
    await noteTerminalFallbackOnItem(runtime, { itemUid, chatLineage: true }, receipt('failed'))
    await noteTerminalFallbackOnItem(runtime, { itemUid, chatLineage: false }, receipt('ready'))
    expect(comments()).toEqual([])
    expect(changed).toEqual([])

    await noteTerminalFallbackOnItem(runtime, { itemUid, chatLineage: true }, receipt('ready'))
    expect(comments()).toHaveLength(1)
    expect(changed).toEqual([itemUid])
    store.dispose()
  })

  it('decides again when a configured alias resolves to a chat-capable agent', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the decision reads only the host settings.
    const runtime = {
      requireStore: () => ({ getSettings: () => TERMINAL_SETTINGS })
    } as unknown as Parameters<typeof lineageModeForResolvedAgent>[0]
    const params = { agent: 'my-claude' }
    const decided = decideWorkerStartMode({
      params,
      settings: TERMINAL_SETTINGS,
      chatLineage: true
    })
    expect(decided.mode).toBe('terminal')
    const start = { chatLineage: true, params, agent: 'claude' }
    expect(lineageModeForResolvedAgent(runtime, decided, start).mode).toBe('structured')
    expect(lineageModeForResolvedAgent(runtime, decided, { ...start, chatLineage: false })).toBe(
      decided
    )
  })
})

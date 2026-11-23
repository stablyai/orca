import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { STRUCTURED_AGENT_RUNTIME_METADATA } from '../../../../../agent-session/installation/structured-agent-runtime-metadata'
import {
  decideWorkerStartMode,
  downgradeWorkerStartModeForHost
} from '../../structured-workers/orchestration-worker-start-mode'

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
})

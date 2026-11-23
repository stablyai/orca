import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import {
  createOrcaSessionId,
  type OrcaSessionId
} from '../../../../../shared/agent-session/identity/orca-session-address'
import { bindWorkerTerminal, keepPaneOpen, paneAutoCloseState } from './worker-bound-terminals'
import {
  closeRetriedFailedSetup,
  closeStoppedWorkerTerminals,
  closeWorkerBoundTerminals
} from '../../../rpc/methods/orchestration/worker/release/worker-bound-terminal-close'
import {
  coordinatorKeepOpenByDefault,
  workerKeepOpenByDefault
} from '../../../rpc/methods/orchestration/worker/start/worker-keep-open-default'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey
} from '../../terminal-authority/structured-sessions/structured-worker-identity'
import { structuredWorkerProcessIncarnation } from '../../terminal-authority/structured-sessions/structured-worker-incarnation'
import { bindTerminalToCallingWorker } from '../../workers/lifecycle/worker-created-terminal-owner'

describe('terminals bound to a worker', () => {
  let directory: string
  let db: OrchestrationDb
  let runId: string
  const botChat = createOrcaSessionId(randomUUID)
  const personChat = createOrcaSessionId(randomUUID)
  const isBotChat = (sessionId: string) => sessionId === botChat

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-worker-bound-terminals-'))
    db = new OrchestrationDb(join(directory, 'orchestration.db'))
    runId = db.createRun({
      objective: 'bound',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    }).id
  })
  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  function startWorker(
    creatorChat: OrcaSessionId,
    setupState = 'running',
    creatorDispatchId?: string,
    chat = false
  ) {
    const task = db.createTask({ runId, spec: 'work' })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'session', orcaSessionId: creatorChat },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      chatLineage: chat
    })
    if (creatorDispatchId) {
      db.db
        .prepare('UPDATE dispatch_contexts SET creator_dispatch_id = ? WHERE id = ?')
        .run(creatorDispatchId, dispatch.id)
    }
    // A chat worker runs as a structured session, not in a terminal.
    const session = createOrcaSessionId(randomUUID)
    const agentHandle = chat ? mintStructuredWorkerHandle() : `term_agent_${dispatch.id}`
    const agentPaneKey = chat
      ? mintStructuredWorkerPaneKey(session)
      : `tab_${dispatch.id}:leaf-agent-${dispatch.id}`
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: agentHandle,
      paneKey: agentPaneKey,
      processIncarnation: chat
        ? structuredWorkerProcessIncarnation(session)
        : 'pty-live:22222222-2222-4222-8222-222222222222',
      worktreeId: 'repo::/worktrees/child',
      setupState,
      effects: [],
      terminalOwnership: 'created'
    })
    const bound = (role: 'setup' | 'configured_tab') => {
      const terminalHandle = `term_${role}_${dispatch.id}`
      const paneKey = `tab_${role}_${dispatch.id}:leaf-${role}-${dispatch.id}`
      bindWorkerTerminal(db, { dispatchId: dispatch.id, terminalHandle, paneKey, role })
      return { terminalHandle, paneKey }
    }
    return {
      dispatchId: dispatch.id,
      session,
      agentHandle,
      agentPaneKey,
      setup: bound('setup'),
      tab: bound('configured_tab')
    }
  }

  // The host's terminals: each bound handle still names its pane until closed.
  function host(...workers: ReturnType<typeof startWorker>[]) {
    const panes = new Map<string, string>([
      ...workers.flatMap((worker): [string, string][] => [
        [worker.setup.terminalHandle, worker.setup.paneKey],
        [worker.tab.terminalHandle, worker.tab.paneKey],
        [worker.agentHandle, worker.agentPaneKey]
      ]),
      ['term_opened', 'tab_opened:leaf-opened'],
      ['term_kept', 'tab_kept:leaf-kept'],
      ['term_person', 'tab_person:leaf-person']
    ])
    const closed: string[] = []
    return {
      closed,
      // An Orca restart mints a new handle for the same pane.
      remint: (handle: string, next: string) => {
        panes.set(next, panes.get(handle)!)
        panes.delete(handle)
      },
      runtime: {
        getExistingOrchestrationDb: () => db,
        getTerminalPaneKey: (handle: string) => panes.get(handle) ?? null,
        getTerminalHandleForPaneKey: (paneKey: string) =>
          [...panes].find(([, pane]) => pane === paneKey)?.[0] ?? null,
        closeTerminal: async (handle: string) => {
          closed.push(handle)
          panes.delete(handle)
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test never reads the close receipt.
          return {} as never
        }
      }
    }
  }

  it('a worker a bot started is not kept open, and its setup terminal closes with it', async () => {
    const worker = startWorker(botChat)
    expect(workerKeepOpenByDefault(db, 'new-child', worker.dispatchId, isBotChat)).toBe(false)
    const helper = startWorker(personChat, 'running', worker.dispatchId)
    expect(workerKeepOpenByDefault(db, 'new-child', helper.dispatchId, isBotChat)).toBe(false)

    const { runtime, closed } = host(worker)
    await closeWorkerBoundTerminals(runtime, db, worker.dispatchId)
    expect(closed).toEqual([worker.setup.terminalHandle, worker.tab.terminalHandle])
  })

  it("a chat worker a bot's home chat started, and the chat workers under it, close with their terminals", async () => {
    const worker = startWorker(botChat, 'running', undefined, true)
    const helper = startWorker(personChat, 'running', worker.dispatchId, true)
    expect(db.getDispatchContextById(helper.dispatchId)?.chat_lineage).toBe(1)
    expect(workerKeepOpenByDefault(db, 'new-child', worker.dispatchId, isBotChat)).toBe(false)
    expect(workerKeepOpenByDefault(db, 'new-child', helper.dispatchId, isBotChat)).toBe(false)

    // Its release (structured stop) closes what is bound to its terminal resource's origin.
    const { runtime, closed } = host(worker)
    await closeStoppedWorkerTerminals(runtime, db, worker.dispatchId)
    expect(closed).toEqual([worker.setup.terminalHandle, worker.tab.terminalHandle])
  })

  it("a person's worker in a new workspace stays open", () => {
    const worker = startWorker(personChat)
    expect(workerKeepOpenByDefault(db, 'new-child', worker.dispatchId, isBotChat)).toBe(true)
    expect(workerKeepOpenByDefault(db, 'new-top-level', worker.dispatchId, isBotChat)).toBe(true)
    expect(workerKeepOpenByDefault(db, 'current', worker.dispatchId, isBotChat)).toBe(false)
  })

  it('a failed setup terminal stays open, with no countdown, until a retry succeeds', async () => {
    const worker = startWorker(botChat, 'failed')
    expect(paneAutoCloseState(db, worker.setup.paneKey)).toBeNull()
    const { runtime, closed } = host(worker)
    await closeWorkerBoundTerminals(runtime, db, worker.dispatchId)
    expect(closed).toEqual([worker.tab.terminalHandle])

    await closeRetriedFailedSetup(runtime, db, worker.dispatchId)
    expect(closed).toEqual([worker.tab.terminalHandle, worker.setup.terminalHandle])
  })

  it('a retry that becomes ready closes the failed setups of every attempt before it', async () => {
    const first = startWorker(botChat, 'failed')
    const second = startWorker(botChat, 'failed')
    db.db
      .prepare('UPDATE dispatch_contexts SET retry_of_dispatch_id = ? WHERE id = ?')
      .run(first.dispatchId, second.dispatchId)
    const { runtime, closed } = host(first, second)
    await closeRetriedFailedSetup(runtime, db, second.dispatchId)
    expect(closed).toEqual([second.setup.terminalHandle, first.setup.terminalHandle])
  })

  it('closes bound terminals found by their pane after Orca reminted their handles', async () => {
    const worker = startWorker(botChat)
    const { runtime, closed, remint } = host(worker)
    remint(worker.setup.terminalHandle, 'term_setup_after_restart')
    remint(worker.tab.terminalHandle, 'term_tab_after_restart')
    await closeWorkerBoundTerminals(runtime, db, worker.dispatchId)
    expect(closed).toEqual(['term_setup_after_restart', 'term_tab_after_restart'])
  })

  it("decides a paired server's worker from this host's coordinator", () => {
    const party = (orcaSessionId: string | null, creatorDispatchId: string | null = null) => ({
      orcaSessionId,
      creatorDispatchId
    })
    expect(coordinatorKeepOpenByDefault(db, 'new-child', party(botChat), isBotChat)).toBe(false)
    expect(coordinatorKeepOpenByDefault(db, 'new-child', party(personChat), isBotChat)).toBe(true)
    // A chat worker a bot started, starting a helper of its own there: its chat is no bot's, but
    // its recorded Dispatch leads back to one.
    const workerChat = createOrcaSessionId(randomUUID)
    const botsWorker = startWorker(botChat)
    expect(
      coordinatorKeepOpenByDefault(
        db,
        'new-child',
        party(workerChat, botsWorker.dispatchId),
        isBotChat
      )
    ).toBe(false)
    const personsWorker = startWorker(personChat)
    expect(
      coordinatorKeepOpenByDefault(
        db,
        'new-child',
        party(workerChat, personsWorker.dispatchId),
        isBotChat
      )
    ).toBe(true)
  })

  it('Keep open on a bound terminal keeps only that one', async () => {
    const worker = startWorker(botChat)
    // A bound terminal shows the worker's own countdown and names the worker's pane.
    expect(paneAutoCloseState(db, worker.agentPaneKey)).toEqual({ kept: false, closesAt: null })
    expect(paneAutoCloseState(db, worker.setup.paneKey)).toEqual({
      kept: false,
      closesAt: null,
      boundTo: {
        paneKey: worker.agentPaneKey,
        worktreeId: 'repo::/worktrees/child',
        name: 'work',
        agent: null
      }
    })

    keepPaneOpen(db, worker.setup.paneKey)
    expect(paneAutoCloseState(db, worker.setup.paneKey)).toBeNull()
    expect(paneAutoCloseState(db, worker.agentPaneKey)).toEqual({ kept: false, closesAt: null })

    const { runtime, closed } = host(worker)
    await closeWorkerBoundTerminals(runtime, db, worker.dispatchId)
    expect(closed).toEqual([worker.tab.terminalHandle])
  })

  it('never closes a handle that now names another pane', async () => {
    const worker = startWorker(botChat)
    const { runtime, closed } = host(worker)
    await closeWorkerBoundTerminals(
      {
        ...runtime,
        getTerminalPaneKey: (handle) =>
          handle === worker.tab.terminalHandle
            ? 'tab_other:leaf-other'
            : runtime.getTerminalPaneKey(handle)
      },
      db,
      worker.dispatchId
    )
    expect(closed).toEqual([worker.setup.terminalHandle])
  })
  it('a terminal its agent opened closes with the worker, unless opened with --keep-open', async () => {
    const worker = startWorker(botChat)
    const { runtime, closed } = host(worker)
    const agent = {
      caller: { kind: 'local-cli' as const },
      orchestrationCompatibilityEvidence: { terminalHandle: worker.agentHandle }
    }
    bindTerminalToCallingWorker(runtime, agent, 'term_opened', false)
    bindTerminalToCallingWorker(runtime, agent, 'term_kept', true)
    // People's windows name no caller; another agent names a terminal that is no worker.
    bindTerminalToCallingWorker(runtime, { caller: { kind: 'desktop' } }, 'term_person', false)
    bindTerminalToCallingWorker(
      runtime,
      {
        caller: agent.caller,
        orchestrationCompatibilityEvidence: { terminalHandle: 'term_person' }
      },
      'term_person',
      false
    )

    await closeWorkerBoundTerminals(runtime, db, worker.dispatchId)
    expect(closed).toEqual([worker.setup.terminalHandle, worker.tab.terminalHandle, 'term_opened'])
  })
})

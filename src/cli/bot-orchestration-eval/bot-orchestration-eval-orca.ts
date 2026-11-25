// The orchestration half of the benchmark's stand-in host: projects, workspaces, workers, mail and
// Linear, answered in the runtime's shapes and recorded, so a bot's hand-offs never reach a real Orca.
// bot-eval-stand-in-contract.test.ts (beside the runtime's worker methods) holds it to their lifecycle.
import { RuntimeClientError } from '../runtime/connection/types'
import type { EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import { BotSuggest } from '../../shared/rpc-contract/bots-look-around-params'
import { beginRun, suggest } from '../../main/bots/bot-look-around-state'
import { check, reply, send } from './bot-orchestration-eval-mail'
import { listed, release, retain, shown, stop } from './bot-orchestration-eval-worker-control'
import {
  EVAL_RUN_ID,
  resolveRepo,
  workerOrThrow,
  workerStart
} from './bot-orchestration-eval-workers'

export type StandInIo = {
  record: (entry: Record<string, unknown>) => void
  save: (state: EvalHostState) => void
}

export function findWorktree(state: EvalHostState, selector: unknown) {
  const text = String(selector ?? '').replace(/^(id|path|name):/, '')
  const found = (state.worktrees ?? []).find(
    (row) => row.worktreeId === text || row.path === text || row.displayName === text
  )
  if (!found) {
    throw new RuntimeClientError('worktree_not_found', 'worktree_not_found')
  }
  return found
}

/** Runs a recorded write: its params, and what came of it, in the log grading reads. */
function recorded(
  io: StandInIo,
  state: EvalHostState,
  method: string,
  params: Record<string, unknown>,
  run: () => { receipt: unknown; verdict: unknown }
): unknown {
  try {
    const { receipt, verdict } = run()
    io.record({ kind: 'write', method, params, ...(verdict ? { result: verdict } : {}) })
    io.save(state)
    return receipt
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const result =
      method === 'orchestration.workerStart'
        ? { accepted: false, error: reason }
        : method === 'orchestration.send'
          ? { delivered: false, error: reason }
          : undefined
    io.record({ kind: 'write', method, params, ...(result ? { result } : {}) })
    throw error
  }
}

/** What an agent's terminal shows, from the scenario's transcript of it. */
function terminalRead(state: EvalHostState, handle: unknown) {
  const transcript = state.terminalTranscripts?.[String(handle)]
  if (transcript === undefined) {
    throw new RuntimeClientError('terminal_not_found', `Terminal ${String(handle)} was not found.`)
  }
  return {
    handle: String(handle),
    status: 'running',
    tail: transcript.split('\n'),
    nextCursor: null,
    truncated: false
  }
}

/** Answers an orchestration-side method, or undefined to leave it to the automation stand-in. */
export function serveOrchestration(
  state: EvalHostState,
  method: string,
  params: Record<string, unknown>,
  io: StandInIo
): unknown {
  const write = (receipt: () => unknown) =>
    recorded(io, state, method, params, () => ({ receipt: receipt(), verdict: null }))
  switch (method) {
    case 'repo.show':
      return { repo: resolveRepo(state, params.repo) }
    case 'worktree.list':
    case 'worktree.ps': {
      const worktrees = state.worktrees ?? []
      return { worktrees, totalCount: worktrees.length, truncated: false }
    }
    case 'worktree.show': {
      // A record names its workspace by id where a ps row says worktreeId.
      const row = findWorktree(state, params.worktree)
      return { worktree: { ...row, id: row.worktreeId } }
    }
    case 'worktree.rm':
      return write(() => {
        const target = findWorktree(state, params.worktree)
        state.worktrees = (state.worktrees ?? []).filter(
          (row) => row.worktreeId !== target.worktreeId
        )
        return { removed: true }
      })
    case 'worktree.set':
      return write(() => {
        const row = findWorktree(state, params.worktree)
        return { worktree: { ...row, id: row.worktreeId } }
      })
    case 'bots.suggest':
      return recorded(io, state, method, params, () => {
        if (!state.lookAround) {
          throw new RuntimeClientError(
            'invalid_argument',
            'Only a look-around run can suggest next steps.'
          )
        }
        const { callerSessionId, ...input } = BotSuggest.parse(params)
        if (!callerSessionId) {
          throw new RuntimeClientError('invalid_argument', 'A look needs its caller session.')
        }
        const now = Date.now()
        const current = state.lookAround.runs.length
          ? state.lookAround
          : beginRun(state.lookAround, callerSessionId, now)
        const next = suggest(current, callerSessionId, input, now)
        state.lookAround = next.state
        if (!next.outcome.ok) {
          throw new RuntimeClientError('invalid_argument', next.outcome.refusal)
        }
        return {
          receipt: {
            suggestion: { id: next.outcome.suggestion.id, title: next.outcome.suggestion.title }
          },
          verdict: { suggested: true }
        }
      })
    case 'terminal.read':
      return { terminal: terminalRead(state, params.terminal) }
    case 'orchestration.runCreate':
      return write(() => ({
        run: { id: EVAL_RUN_ID, objective: params.objective, status: 'active' }
      }))
    case 'orchestration.workerStart':
      return recorded(io, state, method, params, () => workerStart(state, params))
    case 'orchestration.send':
      return recorded(io, state, method, params, () => send(state, params))
    case 'orchestration.check': {
      const result = check(state, params)
      io.save(state)
      return result
    }
    case 'orchestration.workerList':
      return listed(state.workers ?? [])
    case 'orchestration.workerShow':
      return shown(workerOrThrow(state, params.dispatch, 'Worker '))
    case 'orchestration.reply':
      return write(() => reply(state, params))
    case 'orchestration.workerStop':
      return write(() => stop(state, params))
    case 'orchestration.workerRelease':
      return write(() => release(state, params))
    case 'orchestration.workerRetain':
      return write(() => retain(state, params))
  }
  return undefined
}

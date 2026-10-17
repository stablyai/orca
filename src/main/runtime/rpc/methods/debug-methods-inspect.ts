import { defineMethod, type RpcContext } from '../core'
import { debugService, DebugServiceError } from '../../../debug/debug-service'
import type { DebugSessionReader } from '../../../debug/debug-service-trust'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type {
  DebugRefusal,
  DebugResult,
  DebugVariableWire,
  DebugWorktree
} from '../../../../preload/api/debug-api'
import {
  DEBUG_MAX_STACK_LEVELS,
  DEBUG_MAX_VALUE_BYTES,
  DebugEvaluateParams,
  DebugStackParams,
  DebugVariablesParams
} from '../../../../shared/rpc-contract/debug-params'

// Bounds one debug.variables call: depth 3 on a wide object would otherwise fan out unbounded.
const MAX_VARIABLE_NODES = 500

/** The worktree record the selector names; repoId falls back to the one encoded in its id. */
export async function resolveDebugTarget(
  runtime: RpcContext['runtime'],
  selector: string
): Promise<DebugWorktree> {
  const worktree = await runtime.showManagedWorktree(selector)
  return {
    repoId: worktree.repoId || getRepoIdFromWorktreeId(worktree.id),
    worktreePath: worktree.path
  }
}

/** Like the IPC handlers: a service refusal comes back by reason (human-session, debug_unavailable, ...). */
export function toDebugRefusal(error: unknown): DebugRefusal {
  if (error instanceof DebugServiceError) {
    return { ok: false, reason: error.reason, message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, reason: 'request-failed', message }
}

export async function debugResult<T>(work: () => Promise<T>): Promise<DebugResult<T | null>> {
  try {
    return { ok: true, value: (await work()) ?? null }
  } catch (error) {
    return toDebugRefusal(error)
  }
}

/** The stopped thread, else the first thread (pause on a running program). */
export async function defaultThreadId(
  target: DebugWorktree,
  reader: Pick<DebugSessionReader, 'threads'>,
  threadId: number | undefined
): Promise<number> {
  if (threadId !== undefined) {
    return threadId
  }
  const snapshot = await debugService.snapshot(target)
  const id = snapshot.stopped?.threadId ?? (await reader.threads())[0]?.id
  if (id === undefined) {
    throw new DebugServiceError('request-failed', 'No thread to act on; pass threadId.')
  }
  return id
}

/** The top frame of the stopped thread, or undefined when nothing is stopped. */
async function topFrameId(target: DebugWorktree, reader: DebugSessionReader) {
  const stopped = (await debugService.snapshot(target)).stopped
  if (!stopped) {
    return undefined
  }
  return (await reader.stackTrace(stopped.threadId, 0, 1)).stackFrames[0]?.id
}

type VariableNode = DebugVariableWire & { children?: VariableNode[]; truncated?: true }

/** Program memory can hold a value of any size; the RPC answer carries at most 64 KiB of it. */
function capped(text: string): { text: string; truncated?: true } {
  const bytes = Buffer.from(text)
  if (bytes.length <= DEBUG_MAX_VALUE_BYTES) {
    return { text }
  }
  // A cut through a multi-byte character decodes to U+FFFD; drop it.
  const cut = bytes
    .subarray(0, DEBUG_MAX_VALUE_BYTES)
    .toString('utf8')
    .replace(/\uFFFD$/, '')
  return { text: cut, truncated: true }
}

function cappedVariable(variable: DebugVariableWire): VariableNode {
  const { text, truncated } = capped(variable.value)
  return truncated ? { ...variable, value: text, truncated } : variable
}

async function expand(
  reader: DebugSessionReader,
  reference: number,
  depth: number,
  budget: { left: number }
): Promise<VariableNode[]> {
  if (depth === 0 || budget.left <= 0) {
    return []
  }
  const variables = (await reader.variables(reference)).slice(0, budget.left).map(cappedVariable)
  budget.left -= variables.length
  const nodes: VariableNode[] = []
  for (const variable of variables) {
    const nested = depth > 1 && variable.variablesReference > 0
    const children = nested
      ? await expand(reader, variable.variablesReference, depth - 1, budget)
      : undefined
    nodes.push(children ? { ...variable, children } : variable)
  }
  return nodes
}

export const DEBUG_INSPECT_METHODS = [
  defineMethod({
    name: 'debug.stack',
    permission: 'workspace',
    params: DebugStackParams,
    handler: async (params, { runtime }) => {
      const target = await resolveDebugTarget(runtime, params.worktree)
      return debugResult(async () => {
        const reader = await debugService.inspect(target)
        const threadId = await defaultThreadId(target, reader, params.threadId)
        const levels = params.levels ?? DEBUG_MAX_STACK_LEVELS
        return { threadId, ...(await reader.stackTrace(threadId, 0, levels)) }
      })
    }
  }),
  defineMethod({
    name: 'debug.variables',
    permission: 'workspace',
    params: DebugVariablesParams,
    handler: async (params, { runtime }) => {
      const target = await resolveDebugTarget(runtime, params.worktree)
      return debugResult(async () => {
        const reader = await debugService.inspect(target)
        const depth = params.depth ?? 1
        const budget = { left: MAX_VARIABLE_NODES }
        if (params.variablesReference !== undefined) {
          const { variablesReference } = params
          const variables = await expand(reader, variablesReference, depth, budget)
          return { variablesReference, variables, truncated: budget.left <= 0 }
        }
        const frameId = params.frameId ?? (await topFrameId(target, reader))
        if (frameId === undefined) {
          throw new DebugServiceError('request-failed', 'No stopped frame; pass frameId.')
        }
        const scopes = await reader.scopes(frameId)
        const scope =
          scopes.find((s) => s.presentationHint === 'locals' || /^locals$/i.test(s.name)) ??
          scopes.find((s) => !s.expensive)
        if (!scope) {
          throw new DebugServiceError('request-failed', `Frame ${frameId} has no scopes.`)
        }
        const { variablesReference } = scope
        const variables = await expand(reader, variablesReference, depth, budget)
        const truncated = budget.left <= 0
        return { frameId, scope: scope.name, variablesReference, variables, truncated }
      })
    }
  }),
  defineMethod({
    name: 'debug.evaluate',
    permission: 'workspace',
    params: DebugEvaluateParams,
    handler: async (params, { runtime }) => {
      const target = await resolveDebugTarget(runtime, params.worktree)
      return debugResult(async () => {
        // control first: a human-session refusal comes before any frame lookup.
        const session = await debugService.control(target, 'cli')
        const frameId = params.frameId ?? (await topFrameId(target, session))
        const evaluated = await session.evaluate(params.expression, frameId, 'repl')
        const { text, truncated } = capped(evaluated.result)
        return truncated ? { ...evaluated, result: text, truncated } : evaluated
      })
    }
  })
]

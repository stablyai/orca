import type { RuntimeRpcFailure } from '../../../shared/runtime-rpc-envelope'

/**
 * While "Use on this computer again" stops a project's terminals on its WSL host, this window's
 * host panes must not start them again. An open host pane whose terminal the stop killed resumes
 * its agent on the host; the reloaded window then resumes it here too.
 */
const HOST_SPAWN_METHODS: ReadonlySet<string> = new Set([
  'terminal.create',
  'terminal.createAgentSession',
  'terminal.ensureAgentSession',
  'terminal.split',
  'agentSession.create',
  'agentSession.ensure',
  'agentSession.restartResume',
  'agentSession.restartContinue'
])

// Why a cap: a release lost to a crashed reload must not leave the host unusable from here.
const FENCE_MAX_MS = 120_000

const fences = new Map<string, Set<symbol>>()

/** Refuses this window's starts on the host until the returned release runs, or the cap passes. */
export function fenceHostSpawnsForWslMoveUndo(environmentId: string): () => void {
  const token = Symbol(environmentId)
  const tokens = fences.get(environmentId) ?? new Set()
  tokens.add(token)
  fences.set(environmentId, tokens)
  const release = (): void => {
    clearTimeout(timer)
    tokens.delete(token)
    if (tokens.size === 0 && fences.get(environmentId) === tokens) {
      fences.delete(environmentId)
    }
  }
  const timer = setTimeout(release, FENCE_MAX_MS)
  timer.unref?.()
  return release
}

export function isHostSpawnFencedForWslMoveUndo(environmentId: string, method: string): boolean {
  return HOST_SPAWN_METHODS.has(method) && (fences.get(environmentId)?.size ?? 0) > 0
}

export function wslMoveUndoSpawnFencedResponse(
  environment: { runtimeId?: string | null },
  method: string
): RuntimeRpcFailure {
  return {
    id: method,
    ok: false,
    error: {
      code: 'wsl_move_undo_in_progress',
      message: 'This project is moving back to this computer; its terminals start here.'
    },
    _meta: { runtimeId: environment.runtimeId ?? null }
  }
}

export function resetWslMoveUndoSpawnFencesForTests(): void {
  fences.clear()
}

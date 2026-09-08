/**
 * agent-spawn-types.ts — wire-protocol types and trace helper shared across
 * agent-spawner.ts's split modules (CR-AG-12).
 *
 * Split out of agent-spawner.ts (oxlint max-lines) — see that file's header
 * for the full picture of how these pieces fit together.
 *
 * @module relay/agent-spawn-types
 */
import { createTracer } from '../shared/trace'

/** Shared tracer instance for every agent-spawner.ts RPC handler
 *  (agent.spawn / agent.kill / agent.sendInput) — kept as a single
 *  module-level instance so spans from all handlers land under the same
 *  'agent:spawn' tracer, not one per split file. */
export const spawnerTracer = createTracer('agent:spawn')

// ─── Trace propagation helper ───────────────────────────────────────────────
// Agent WS JSON-RPC 2.0: traceId nested at params._trace.id (CR-TRACE-000 §3.3).
export function extractResume(params: Record<string, unknown>): { id: string } | undefined {
  const t = params['_trace']
  if (t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string') {
    return { id: (t as { id: string }).id }
  }
  return undefined
}

// ── Types ──────────────────────────────────────────────────────────────────────

export type AgentLifecycleState = 'idle' | 'spawning' | 'running' | 'stopping' | 'stopped' | 'error'

/**
 * AgentBinarySpec: mô tả binary và cách build args cho mỗi model type.
 * apiKeyEnvVar = null nghĩa là model không cần API key (local inference / opencode).
 */
export type AgentBinarySpec = {
  readonly binary: string
  readonly buildArgs: (req?: {
    resumeId?: string
    trustPreset?: 'standard' | 'full' | 'none'
  }) => string[]
  readonly apiKeyEnvVar: string | null
  readonly localInference?: boolean
}

export type AgentSpawnRequest = {
  taskId: string
  userId: string
  modelId: string
  accountId: string
  cwd?: string
  resumeId?: string // ORCH-009: --resume <sessionId> for claude/codex
  worktreePath?: string // WT-Issue-3: absolute path of worktree (usually same as cwd)
  branchName?: string // WT-Issue-3: git branch this worktree corresponds to
  cols?: number // BUG-AG-HLD-006: real terminal width; falls back to DEFAULT_PTY_COLS
  rows?: number // BUG-AG-HLD-006: real terminal height; falls back to DEFAULT_PTY_ROWS
  trustPreset?: 'standard' | 'full' | 'none' // BUG-AG-HLD-008: 'full' → thêm flag skip-permission của CLI
}

export type AgentStatusEvent = {
  type: 'spawn.accepted' | 'spawn.started' | 'spawn.output' | 'spawn.exit' | 'spawn.error'
  ptyId?: string
  taskId?: string
  data?: string
  code?: number
  error?: string
}

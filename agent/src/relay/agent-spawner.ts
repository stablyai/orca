/**
 * agent-spawner.ts — Dev Server tier SubAgent spawner (CR-AG-12)
 *
 * ⚠️ KHÔNG nhầm với src/main/project/ProfileAwareAgentSpawner.ts (Orca Server tier)
 *    Đây là relay-side spawner cho sub-agent process management.
 *
 * Split across several files to stay under oxlint's max-lines budget (mirrors
 * the agent-rpc-dispatch-{git,fs,browser,...}.ts split already in this
 * directory). This file remains the entry point — every symbol below is
 * re-exported here so no external import path changes:
 *   agent-spawn-types.ts    — wire-protocol types + trace helper
 *   agent-binary-specs.ts   — per-model AgentBinarySpec table + arg builder
 *   agent-spawn-env.ts      — buildAgentEnv (credential → process env)
 *   agent-pty-registry.ts   — PTY registry, connection rebind, grace period, cleanup
 *   agent-spawn-control.ts  — handleAgentKill / handleAgentSendInput
 *
 * Exports:
 *   SubAgentSpawner        — class lifecycle manager (pure, testable)
 *   handleAgentSpawn       — RPC handler (fire-and-forget streaming)
 *   handleAgentKill        — RPC handler
 *   handleAgentSendInput   — RPC handler (write to PTY stdin)
 *   cleanupAllPtys         — cleanup PTYs on session close
 *   buildAgentEnv          — env builder (testable with mock credStore)
 *   resolveAgentSpec       — model → binary spec (pure, testable)
 *
 * @module relay/agent-spawner
 */
// node-pty is loaded lazily (dynamic import) so agent.js can start on servers
// that do NOT have node-pty installed (it is marked external in the build).
// The dynamic import happens only when agent.spawn is actually called.
import type * as nodePtyTypes from 'node-pty'
import type WebSocket from 'ws'
import type { AgentConfig } from './agent-config'
import type { AgentLogger } from './agent-logger'
import { encodeDataFrame, createWireState } from 'orca-dev-agent-transport'
import type { WireState } from 'orca-dev-agent-transport'
import { Tracers } from '../shared/trace/tracers'
import { AgentErrorCode } from '../shared/agent-wire-protocol'
import { extractResume, spawnerTracer } from './agent-spawn-types'
import type { AgentLifecycleState, AgentSpawnRequest } from './agent-spawn-types'
import { resolveAgentSpec, buildAgentArgs } from './agent-binary-specs'
import { buildAgentEnv } from './agent-spawn-env'
import {
  PTY_REGISTRY,
  rebindAgentSpawnConnection,
  sendAgentSpawnNotification
} from './agent-pty-registry'

// ── Re-exports (public API — unchanged for external importers) ───────────────
export type {
  AgentLifecycleState,
  AgentBinarySpec,
  AgentSpawnRequest,
  AgentStatusEvent
} from './agent-spawn-types'
export type { AgentEnvRequest } from './agent-spawn-env'
export { resolveAgentSpec, buildAgentEnv }
export {
  rebindAgentSpawnConnection,
  AGENT_SPAWN_PTY_GRACE_PERIOD_MS,
  scheduleAgentSpawnGracePeriod,
  cleanupAllPtys
} from './agent-pty-registry'
export { handleAgentKill, handleAgentSendInput } from './agent-spawn-control'

// ── SubAgentSpawner (pure class — testable) ───────────────────────────────────

export class SubAgentSpawner {
  private state: AgentLifecycleState = 'idle'

  getState(): AgentLifecycleState {
    return this.state
  }

  transition(next: AgentLifecycleState): void {
    const VALID: Record<AgentLifecycleState, AgentLifecycleState[]> = {
      idle: ['spawning'],
      spawning: ['running', 'error'],
      running: ['stopping', 'error'],
      stopping: ['stopped', 'error'],
      stopped: ['idle'],
      error: ['idle']
    }
    if (!VALID[this.state]?.includes(next)) {
      throw new Error(`SubAgentSpawner: invalid transition ${this.state} → ${next}`)
    }
    this.state = next
  }
}

// ── PTY size defaults ─────────────────────────────────────────────────────────
// BUG-AG-HLD-006: caller (Orca client) nên gửi cols/rows thật của terminal đang
// hiển thị agent panel. Giữ 220×50 làm fallback cho caller cũ chưa gửi field này.
const DEFAULT_PTY_COLS = 220
const DEFAULT_PTY_ROWS = 50

// ── handleAgentSpawn (fire-and-forget) ────────────────────────────────────────

export async function handleAgentSpawn(
  id: string | number | null,
  params: Record<string, unknown>,
  config: AgentConfig,
  log: AgentLogger,
  ws: WebSocket,
  _state: WireState
): Promise<Record<string, unknown>> {
  const wireState = createWireState()

  // Accept both 'model' (from tests/new spec) and 'modelId' (legacy)
  const modelId =
    typeof params.model === 'string'
      ? params.model
      : typeof params.modelId === 'string'
        ? params.modelId
        : ''

  const req: AgentSpawnRequest = {
    taskId: typeof params.taskId === 'string' ? params.taskId : '',
    userId: typeof params.userId === 'string' ? params.userId : '',
    modelId,
    accountId: typeof params.accountId === 'string' ? params.accountId : '',
    cwd: typeof params.cwd === 'string' ? params.cwd : undefined,
    resumeId: typeof params.resumeId === 'string' ? params.resumeId : undefined,
    worktreePath: typeof params.worktreePath === 'string' ? params.worktreePath : undefined,
    branchName: typeof params.branchName === 'string' ? params.branchName : undefined,
    // BUG-AG-HLD-006: only accept positive integers — a malformed/negative value
    // must not reach node-pty.spawn(), which throws on invalid cols/rows.
    cols:
      Number.isInteger(params.cols) && (params.cols as number) > 0
        ? (params.cols as number)
        : undefined,
    rows:
      Number.isInteger(params.rows) && (params.rows as number) > 0
        ? (params.rows as number)
        : undefined,
    trustPreset:
      params.trustPreset === 'full' || params.trustPreset === 'none'
        ? params.trustPreset
        : undefined // mặc định 'standard' (không thêm flag) nếu thiếu/không hợp lệ
  }
  // ORCH-003: Orca Server may inject pre-resolved plaintext API key
  const resolvedApiKey =
    typeof params.resolvedApiKey === 'string' ? params.resolvedApiKey : undefined

  const span = spawnerTracer.start({
    method: 'agent.spawn',
    taskId: req.taskId,
    modelId: req.modelId
  })

  // BL-AG-01 vs BL-AG-03: same code path, distinguished by req.resumeId (already existed)
  const orchTracer = req.resumeId ? Tracers.agentOrchResume : Tracers.agentOrchSpawn
  const orchSpan = orchTracer.start(
    { taskId: req.taskId, modelId: req.modelId, resumeId: req.resumeId },
    extractResume(params)
  )

  // ── Validation ────────────────────────────────────────────────────────────────
  const missing: string[] = []
  if (!req.modelId) {
    missing.push('model')
  }
  if (!req.taskId) {
    missing.push('taskId')
  }
  if (!req.userId) {
    missing.push('userId')
  }
  if (!req.cwd) {
    missing.push('cwd')
  }

  if (missing.length > 0) {
    span.fail(`missing ${missing.join(',')}`, { taskId: req.taskId, modelId: req.modelId })
    orchSpan.fail(`missing ${missing.join(',')}`, { taskId: req.taskId })
    const errResp = {
      jsonrpc: '2.0',
      id,
      error: {
        code: AgentErrorCode.InvalidParams,
        message: `Missing required fields: ${missing.join(', ')}`
      }
    }
    try {
      ws.send(encodeDataFrame(wireState, JSON.stringify(errResp)))
    } catch {
      /* WS may be closed */
    }
    return errResp
  }

  // Resolve spec
  const specResolved = resolveAgentSpec(req.modelId)
  if (!specResolved) {
    span.fail('unknown model', { modelId: req.modelId })
    orchSpan.fail('unknown model', { modelId: req.modelId })
    const errResp = {
      jsonrpc: '2.0',
      id,
      error: { code: AgentErrorCode.InvalidParams, message: `Unknown model: ${req.modelId}` }
    }
    try {
      ws.send(encodeDataFrame(wireState, JSON.stringify(errResp)))
    } catch {
      /* WS may be closed */
    }
    return errResp
  }

  const spawner = new SubAgentSpawner()

  try {
    spawner.transition('spawning')

    // specResolved already validated above (not null)
    const spec = specResolved
    // ORCH-003: Pass spec and resolvedApiKey — no more 'placeholder-key'
    orchSpan.step('resolve-credential', { accountId: req.accountId || '(none)' })
    const envBase = await buildAgentEnv(
      req,
      spec,
      config,
      resolvedApiKey ?? null,
      log,
      span.id // NEW — CR-TRACE-016 correlation field (spawnerTracer span, NOT orchSpan)
    )
    // WT-Issue-3: Inject worktree context so agent knows which branch/path it owns
    const env: Record<string, string> = {
      ...envBase,
      ...(req.worktreePath ? { ORCA_WORKTREE_PATH: req.worktreePath } : {}),
      ...(req.branchName ? { ORCA_WORKTREE_BRANCH: req.branchName } : {})
    }

    // ORCH-011: ptyId includes userId to prevent cross-user collision
    const ptyId = `pty-${req.userId}-${req.taskId}-${Date.now()}`
    // ORCH-012/004: Use buildAgentArgs (handles resume + correct args per model)
    const args = buildAgentArgs(spec, req)

    // Pre-spawn validation: check binary exists in toolPath to fail fast + synchronously
    const { existsSync: fsExistsSync } = await import('node:fs')
    const { join: pathJoin } = await import('node:path')
    const toolPathDirs = (config.toolPath ?? '').split(':').filter(Boolean)
    const binaryExists =
      process.platform === 'win32'
        ? true // Windows PATH lookup is different — skip check
        : toolPathDirs.some((dir) => fsExistsSync(pathJoin(dir, spec.binary))) ||
          !toolPathDirs.length // no toolPath configured → use system PATH (always ok)

    if (!binaryExists) {
      throw new Error(
        `Agent binary '${spec.binary}' not found in toolPath '${config.toolPath ?? '(empty)'}'. ` +
          `Install it or set toolPath to the directory containing '${spec.binary}'.`
      )
    }

    // Lazy-load node-pty — only imported when a PTY spawn is actually needed.
    // This allows agent.js to start on servers without node-pty installed.
    let nodePty: typeof nodePtyTypes
    try {
      nodePty = await import('node-pty')
    } catch {
      throw new Error(
        `node-pty is not installed on this dev server. ` +
          `Run: npm install node-pty  (in ~/orca-agent/)  to enable PTY-based agent spawning.`
      )
    }

    orchSpan.step('node-pty-spawn', { binary: spec.binary, ptyId })
    const pty = nodePty.spawn(spec.binary, args, {
      name: 'xterm-256color',
      cols: req.cols ?? DEFAULT_PTY_COLS,
      rows: req.rows ?? DEFAULT_PTY_ROWS,
      cwd: req.cwd ?? config.workDir,
      env
    })

    PTY_REGISTRY.set(ptyId, { pty, taskId: req.taskId, userId: req.userId, graceTimer: null })
    // CR-STORAGE-008(b): this call's (ws, wireState) becomes "the current
    // connection" for every agent.spawn PTY (including ones from earlier,
    // still-running spawns) — see rebindAgentSpawnConnection's doc comment.
    // Also cancels any grace timers left over from a just-recovered disconnect.
    rebindAgentSpawnConnection(ws, wireState)
    spawner.transition('running')
    span.step('pty-running', { ptyId, modelId: req.modelId })

    log.info(`agent.spawn: ptyId=${ptyId} model=${req.modelId}`)

    // ORCH-006: JSON-RPC 2.0 requires notifications (no id) for streaming output.
    // Sending multiple responses with the same id violates the spec.
    // BL-AG-05: state-transition on the ALREADY-OPEN span, not a new span per frame.
    // CR-STORAGE-008(b): pushed via sendAgentSpawnNotification (routes to
    // whichever connection is CURRENT at delivery time), not the `ws`/`wireState`
    // closed over at spawn time — those go stale the moment this connection
    // drops and a new one takes over after reconnect.
    let firstOutputReported = false
    pty.onData((data) => {
      if (!firstOutputReported) {
        firstOutputReported = true
        orchSpan.step('first-output', { ptyId })
      }
      sendAgentSpawnNotification('agent.output', {
        ptyId,
        data: Buffer.from(data).toString('base64')
      })
    })

    // ORCH-006: onExit also uses notification
    pty.onExit(({ exitCode }) => {
      const entry = PTY_REGISTRY.get(ptyId)
      if (entry?.graceTimer) {
        clearTimeout(entry.graceTimer)
      }
      PTY_REGISTRY.delete(ptyId)
      spawner.transition('stopping')
      spawner.transition('stopped')
      if (exitCode === 0) {
        span.ok({ ptyId, exitCode })
        orchSpan.ok({ ptyId, exitCode })
      } else {
        span.fail(`exit code ${exitCode}`, { ptyId, exitCode })
        orchSpan.fail(`exit code ${exitCode}`, { ptyId, exitCode })
      }
      sendAgentSpawnNotification('agent.exited', { ptyId, exitCode })
      log.info(`agent.spawn: ptyId=${ptyId} exited code=${exitCode}`)
    })

    return { jsonrpc: '2.0', id, result: { ok: true, ptyId } }
  } catch (err: unknown) {
    spawner.transition('error')
    const msg = err instanceof Error ? err.message : String(err)
    span.fail(err, { taskId: req.taskId, modelId: req.modelId })
    orchSpan.fail(err, { taskId: req.taskId, modelId: req.modelId })
    log.error(`agent.spawn: error ${msg}`)
    const errWireState = createWireState()
    const errResp = {
      jsonrpc: '2.0',
      id,
      error: { code: AgentErrorCode.ServerError, message: msg }
    }
    ws.send(encodeDataFrame(errWireState, JSON.stringify(errResp)))
    return errResp
  }
}

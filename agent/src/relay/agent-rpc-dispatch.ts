// src/relay/agent-rpc-dispatch.ts
// JSON-RPC 2.0 router for the Orca Dev Agent.
//
// Design:
//   - createRpcDispatcher() returns a stateless RpcDispatcher object
//   - dispatch() encodes and sends the response via ws.send()
//   - v5.0 methods (git.*, fs.*, ai.provider.*) use dynamic import so that
//     modules not yet created don't break agent startup
//   - All handler exceptions are caught and returned as ServerError responses
//   - ws.readyState === 1 (OPEN) is checked before every send
//
// The giant per-method switch statement used to live entirely in this file;
// it is now split by RPC-method domain into agent-rpc-dispatch-*.ts files
// (git, git-status, fs, scm, ai, agent-exec, pty, browser, misc) to stay
// under the oxlint max-lines budget. This file keeps the tracing/dispatch
// wrapper and the shared helpers those domain files import, and routes each
// request to the first domain dispatcher that handles it.

import type WebSocket from 'ws'
import type { ToolDefinition, ToolResult } from './agent-tool-registry'
import type { AgentConfig } from './agent-config'
import type { AgentLogger } from './agent-logger'
import type { WireState } from 'orca-dev-agent-transport'
import { encodeDataFrame } from 'orca-dev-agent-transport'
import { AgentErrorCode } from '../shared/agent-wire-protocol'
import { createTracer } from '../shared/trace'
import { dispatchGitRpc } from './agent-rpc-dispatch-git'
import { dispatchGitHooksRpc } from './agent-rpc-dispatch-git-hooks'
import { dispatchGitStatusRpc } from './agent-rpc-dispatch-git-status'
import { dispatchFsRpc } from './agent-rpc-dispatch-fs'
import { dispatchScmRpc } from './agent-rpc-dispatch-scm'
import { dispatchAiRpc } from './agent-rpc-dispatch-ai'
import { dispatchAgentExecRpc } from './agent-rpc-dispatch-agent-exec'
import { dispatchPtyRpc } from './agent-rpc-dispatch-pty'
import { dispatchBrowserRpc } from './agent-rpc-dispatch-browser'
import { dispatchMiscRpc } from './agent-rpc-dispatch-misc'
import { dispatchCliRpc } from './agent-rpc-dispatch-cli'
import { dispatchAccountsRpc } from './agent-rpc-dispatch-accounts'
import { dispatchVmRpc } from './agent-rpc-dispatch-vm'
import { dispatchHiddenTargetRpc } from './agent-rpc-dispatch-hidden-target'

const rpcTracer = createTracer('agent:rpc')

// ─── Trace resume extraction ────────────────────────────────────────────────
// Agent WS JSON-RPC 2.0: traceId nested at params._trace.id (CR-TRACE-000 §3.3).
// Exported: agent-rpc-dispatch-agent-exec.ts's agent.exec case also resumes
// the agentOrch:spawn span from the same params._trace.id.
export function extractResume(params: Record<string, unknown>): { id: string } | undefined {
  const t = params['_trace']
  if (t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string') {
    return { id: (t as { id: string }).id }
  }
  return undefined
}

// ─── JSON-RPC types ───────────────────────────────────────────────────────────

export type JsonRpcRequest = {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly method: string
  readonly params?: Record<string, unknown>
}

type JsonRpcSuccess = {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result: unknown
}

type JsonRpcError = {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly error: { code: number; message: string; data?: unknown }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

// ─── RpcDispatcher ────────────────────────────────────────────────────────────

export type RpcDispatcher = {
  dispatch(ws: WebSocket, state: WireState, rpc: JsonRpcRequest): Promise<void>
}

// ─── Trace field extraction ───────────────────────────────────────────────────
// Extracts meaningful context fields from RPC params per method group.
// This centralizes all trace context logic in one place.

type TraceFields = Record<string, string | number | boolean | undefined>

function extractTraceFields(method: string, params: Record<string, unknown>): TraceFields {
  const p = params
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
  const truncPath = (v: unknown) => {
    const s = str(v)
    return s ? (s.length > 60 ? `...${s.slice(-57)}` : s) : undefined
  }
  const truncCmd = (v: unknown) => {
    const s = str(v)
    return s ? (s.length > 80 ? `${s.slice(0, 77)}...` : s) : undefined
  }

  if (method.startsWith('fs.') || method === 'shell.eval' || method === 'preflight.check') {
    return {
      path: truncPath(p['path'] ?? p['dir'] ?? p['filePath']),
      pattern: str(p['pattern']),
      cmd: method === 'shell.eval' ? truncCmd(p['cmd']) : undefined
    }
  }

  if (method.startsWith('git.')) {
    return {
      repo: truncPath(p['repoPath'] ?? p['workDir']),
      cmd: truncCmd(p['cmd'] ?? p['args']),
      branch: str(p['branch']),
      worktree: truncPath(p['worktreePath'] ?? p['path'])
    }
  }

  if (method.startsWith('github.') || method.startsWith('gitlab.')) {
    return {
      repo: str(p['repo'] ?? p['project']),
      branch: str(p['branch'] ?? p['sourceBranch']),
      prNum: num(p['prNumber'] ?? p['mrIid']),
      title: str(p['title'])?.slice(0, 40)
    }
  }

  if (method.startsWith('ai.provider.')) {
    return {
      provider: str(p['provider'] ?? p['providerId'])
      // Never log credential value — just the provider name
    }
  }

  if (method === 'tools/call') {
    return {
      tool: str(p['name'])
    }
  }

  if (method === 'ai.complete') {
    // CR-TRACE-018 BL-TG-02: this method used to fall through to `return {}`
    // — the outer agent:rpc span had no context fields at all. This is a thin
    // dispatch-level wrapper (id, timing of the whole dispatch incl. the
    // dynamic import of ./ai-complete-handler); the detailed breakdown
    // (provider-call step, contentLength, fail reason) lives in the separate
    // agent:aiComplete tracer (ai-complete-handler.ts, TASK-AG-005.1) — the two
    // are complementary, not duplicates.
    return {
      model: str(p['model']),
      taskId: str(p['taskId']),
      promptLength: typeof p['prompt'] === 'string' ? (p['prompt'] as string).length : undefined
    }
  }

  if (method === 'agent.exec') {
    // CR-TRACE-015 BL-PRF-04: agent.exec (non-interactive, used by
    // ProfileAwareAgentSpawner.spawn() on the backend) has a params shape
    // completely different from agent.spawn (interactive PTY) — the generic
    // 'agent.' bucket below (session/binary/cmd) doesn't match any field of
    // agent.exec, which used to leave the span showing session=undefined
    // cmd=undefined. This dedicated bucket matches { binary, args, cwd, env,
    // timeoutMs } instead. Must be checked BEFORE the 'agent.' prefix bucket.
    return {
      // (TASK-AG-015.1) base — request shape:
      binary: str(p['binary']),
      argsCount: Array.isArray(p['args']) ? (p['args'] as unknown[]).length : undefined,
      hasEnvOverride: p['env'] !== undefined && p['env'] !== null,
      timeoutMs: num(p['timeoutMs']),
      // CR-TRACE-017 BL-WF-02: StepExecutors.executeAgent() already sends
      // `stepId` — this field has a real value immediately, no backend change needed.
      stepId: str(p['stepId']),
      // CR-TRACE-017 §4: `parentTraceId` is a plain business field so the
      // TracePanel can group every step-span of the same workflow execution —
      // NOT Tracer.start()'s `resume` mechanism (CR-TRACE-000 §3.1), since that
      // core API hasn't shipped. Only populated once WorkflowOrchestrator.ts is
      // updated to send `traceId: stepSpan.id` + `parentTraceId: rootTraceId` in
      // the relay.call('agent.exec', ...) params — until then this stays
      // undefined without error (agent side is ready, no second edit needed).
      parentTraceId: str(p['parentTraceId']),
      // CR-TRACE-018 BL-TG-04: only populated once the backend
      // (ProfileAwareAgentSpawner.spawn() / TaskAgentExecutor) is updated to
      // send `taskId` as a top-level param instead of only inside
      // `env.ORCA_TASK_ID` — until then this stays undefined without error.
      taskId: str(p['taskId'])
    }
  }

  if (method.startsWith('agent.')) {
    return {
      session: str(p['sessionId'] ?? p['taskId']),
      binary: str(p['binary'] ?? p['model'] ?? p['modelId']),
      cmd: truncCmd(p['cmd'] ?? p['command'])
    }
  }

  return {}
}

// ─── Result field extraction (generic — extend as more methods need it) ──────
// Surfaces result-level fields the handler already computed (e.g.
// exitCode/timedOut for agent.exec) onto span.ok(), instead of only { method }.
function extractResultFields(method: string, result: unknown): TraceFields {
  if (method === 'agent.exec' && result && typeof result === 'object') {
    const r = result as Record<string, unknown>
    return {
      exitCode: typeof r['exitCode'] === 'number' ? r['exitCode'] : undefined,
      timedOut: typeof r['timedOut'] === 'boolean' ? r['timedOut'] : undefined
    }
  }
  return {}
}

export function createRpcDispatcher(
  tools: ToolDefinition[],
  config: AgentConfig,
  log: AgentLogger
): RpcDispatcher {
  return {
    async dispatch(ws: WebSocket, state: WireState, rpc: JsonRpcRequest): Promise<void> {
      const ctxFields = extractTraceFields(rpc.method, rpc.params ?? {})
      const span = rpcTracer.start(
        { method: rpc.method, id: String(rpc.id ?? 'notify'), ...ctxFields },
        extractResume(rpc.params ?? {})
      )
      let response: JsonRpcResponse
      try {
        response = await route(rpc, tools, config, log, ws, state)
        // JsonRpcError (method-level failures) are still 'ok' at transport level
        if ('error' in response) {
          span.fail(response.error.message, { method: rpc.method, code: response.error.code })
        } else {
          // CR-TRACE-015 BL-PRF-04: surface result-level fields the handler
          // already computed (exitCode/timedOut for agent.exec) instead of { method }.
          span.ok({ method: rpc.method, ...extractResultFields(rpc.method, response.result) })
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error(`RPC dispatch unhandled error method=${rpc.method}: ${msg}`)
        span.fail(msg, { method: rpc.method, phase: 'dispatch' })
        response = makeError(rpc.id, AgentErrorCode.ServerError, `Internal error: ${msg}`)
      }

      if (ws.readyState === 1 /* WebSocket.OPEN */) {
        // TEMP DIAG BUG-FE-PTY-001
        const frame = encodeDataFrame(state, JSON.stringify(response))
        log.info(
          `[DIAG BUG-FE-PTY-001] send response id=${rpc.id} method=${rpc.method} bytes=${frame.length} bufferedAmount=${ws.bufferedAmount} t=${Date.now()}`
        )
        ws.send(frame, (err) => {
          if (err) {
            log.error(
              `[DIAG BUG-FE-PTY-001] ws.send callback ERROR id=${rpc.id}: ${err.stack ?? err.message}`
            )
          }
        })
      } else {
        log.error(
          `[DIAG BUG-FE-PTY-001] skipped send — readyState=${ws.readyState} id=${rpc.id} method=${rpc.method}`
        )
      }
    }
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

/**
 * Builds a one-way JSON-RPC notification sender bound to this connection.
 * Used by long-lived agent-side resources (PTY sessions, fs watchers) to push
 * data back to Orca outside the request/response cycle — the same frame codec
 * as regular responses, just without an `id`.
 *
 * Exported: the per-domain dispatch files (git, fs, agent-exec, pty, browser)
 * bind their own long-lived-resource notifiers from this same function.
 */
export function makeNotifier(
  ws: WebSocket,
  state: WireState
): (method: string, params: Record<string, unknown>) => void {
  return (method, params) => {
    if (ws.readyState !== 1 /* WebSocket.OPEN */) {
      return
    }
    ws.send(encodeDataFrame(state, JSON.stringify({ jsonrpc: '2.0', method, params })))
  }
}

// Tries each RPC-method-domain dispatcher in turn, returning the first
// non-null result. Preserves the original single giant switch's exact
// control flow: every case name below is handled by exactly one domain
// dispatcher, and an unmatched method falls through to the same
// MethodNotFound response the old `default:` case returned.
async function route(
  rpc: JsonRpcRequest,
  tools: ToolDefinition[],
  config: AgentConfig,
  log: AgentLogger,
  ws: WebSocket,
  state: WireState
): Promise<JsonRpcResponse> {
  const fromGit = await dispatchGitRpc(rpc, config, log, ws, state)
  if (fromGit !== null) {
    return fromGit
  }

  const fromGitHooks = await dispatchGitHooksRpc(rpc, config, log)
  if (fromGitHooks !== null) {
    return fromGitHooks
  }

  const fromGitStatus = await dispatchGitStatusRpc(rpc, ws)
  if (fromGitStatus !== null) {
    return fromGitStatus
  }

  const fromFs = await dispatchFsRpc(rpc, config, ws, state)
  if (fromFs !== null) {
    return fromFs
  }

  const fromScm = await dispatchScmRpc(rpc, config, log)
  if (fromScm !== null) {
    return fromScm
  }

  const fromAi = await dispatchAiRpc(rpc, config, log)
  if (fromAi !== null) {
    return fromAi
  }

  const fromAgentExec = await dispatchAgentExecRpc(rpc, config, log, ws, state)
  if (fromAgentExec !== null) {
    return fromAgentExec
  }

  const fromPty = await dispatchPtyRpc(rpc, log, ws, state)
  if (fromPty !== null) {
    return fromPty
  }

  const fromBrowser = await dispatchBrowserRpc(rpc, log, ws, state)
  if (fromBrowser !== null) {
    return fromBrowser
  }

  const fromMisc = await dispatchMiscRpc(rpc, tools, config, log, ws, state)
  if (fromMisc !== null) {
    return fromMisc
  }

  const fromCli = await dispatchCliRpc(rpc)
  if (fromCli !== null) {
    return fromCli
  }

  const fromAccounts = await dispatchAccountsRpc(rpc)
  if (fromAccounts !== null) {
    return fromAccounts
  }

  const fromVm = await dispatchVmRpc(rpc, ws, state)
  if (fromVm !== null) {
    return fromVm
  }

  const fromHiddenTarget = await dispatchHiddenTargetRpc(rpc)
  if (fromHiddenTarget !== null) {
    return fromHiddenTarget
  }

  // ── Unknown method ───────────────────────────────────────────────────────
  return makeError(rpc.id, AgentErrorCode.MethodNotFound, `Method not found: ${rpc.method}`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a ToolResult as an MCP-compatible JSON-RPC success response.
 * content[0].type is always 'text', isError reflects exitCode !== 0.
 */
export function formatMcpResult(id: string | number | null, result: ToolResult): JsonRpcSuccess {
  const text = [result.stdout || '', result.stderr ? `[stderr]\n${result.stderr}` : '']
    .filter(Boolean)
    .join('\n')
    .trim()

  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: text || '(no output)' }],
      isError: result.exitCode !== 0,
      exitCode: result.exitCode,
      meta: result.meta
    }
  }
}

export function makeError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcError {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined && { data }) }
  }
}

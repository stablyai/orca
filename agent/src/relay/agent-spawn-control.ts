/**
 * agent-spawn-control.ts — handleAgentKill / handleAgentSendInput RPC
 * handlers for already-running agent.spawn PTYs (CR-AG-12).
 *
 * Split out of agent-spawner.ts (oxlint max-lines) — see that file's header
 * for the full picture of how these pieces fit together.
 *
 * @module relay/agent-spawn-control
 */
import type { AgentConfig } from './agent-config'
import type { AgentLogger } from './agent-logger'
import { Tracers } from '../shared/trace/tracers'
import { AgentErrorCode } from '../shared/agent-wire-protocol'
import { extractResume, spawnerTracer } from './agent-spawn-types'
import { PTY_REGISTRY } from './agent-pty-registry'

// ── handleAgentKill ───────────────────────────────────────────────────────────

export async function handleAgentKill(
  id: string | number | null,
  params: Record<string, unknown>,
  _config: AgentConfig,
  log: AgentLogger
): Promise<object> {
  const ptyId = typeof params.ptyId === 'string' ? params.ptyId : ''
  // ORCH-002: Respect the caller's signal choice (SIGTERM = graceful, SIGKILL = force)
  const rawSignal = typeof params.signal === 'string' ? params.signal : 'SIGTERM'
  const signal: 'SIGTERM' | 'SIGKILL' = rawSignal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'
  const span = spawnerTracer.start({ method: 'agent.kill', ptyId: ptyId || '(empty)', signal })
  const orchSpan = Tracers.agentOrchStop.start(
    { ptyId: ptyId || '(empty)', signal, via: 'agent.kill' },
    extractResume(params)
  )

  if (!ptyId) {
    span.fail('missing ptyId', { method: 'agent.kill' })
    orchSpan.fail('missing ptyId')
    return {
      jsonrpc: '2.0',
      id,
      error: { code: AgentErrorCode.InvalidParams, message: 'Missing ptyId' }
    }
  }

  const entry = PTY_REGISTRY.get(ptyId)
  if (!entry) {
    span.ok({ ptyId, note: 'already dead' })
    orchSpan.ok({ ptyId, note: 'already dead' })
    return { jsonrpc: '2.0', id, result: { ok: true, note: 'pty not found (already dead)' } }
  }

  // ORCH-002: Use the validated signal from params
  if (process.platform === 'win32') {
    entry.pty.kill() // Windows: no signal semantics
  } else {
    entry.pty.kill(signal)
  }
  PTY_REGISTRY.delete(ptyId)
  span.ok({ ptyId, signal })
  orchSpan.ok({ ptyId, signal })
  log.info(`agent.kill: ptyId=${ptyId} ${signal} sent`)
  return { jsonrpc: '2.0', id, result: { ok: true } }
}

// ── handleAgentSendInput ──────────────────────────────────────────────────────
// ORCH-001: New handler for sending data to PTY stdin.
// Used for graceful stop (send '\x03' = Ctrl+C) and arbitrary terminal input.

export async function handleAgentSendInput(
  id: string | number | null,
  params: Record<string, unknown>,
  _config: AgentConfig,
  log: AgentLogger
): Promise<object> {
  const ptyId = typeof params.ptyId === 'string' ? params.ptyId : ''
  const data = typeof params.data === 'string' ? params.data : ''
  // Ctrl+C is the graceful-stop signal worth tracing (agentOrch:stop); regular
  // interactive keystrokes are per-frame and excluded (CR-TRACE-000 §5).
  const isGracefulStop = data === '\x03'
  const orchSpan = isGracefulStop
    ? Tracers.agentOrchStop.start({ ptyId, via: 'agent.sendInput' }, extractResume(params))
    : undefined
  // CR-TRACE-005: separate infra span (agent:spawn, reused — not a new tracer)
  // covering EVERY call, not just Ctrl+C — records ptyId on every event so
  // BL-CR-02/03 remote-feedback-into-PTY calls are traceable even when they
  // aren't the graceful-stop byte.
  const span = spawnerTracer.start({ method: 'agent.sendInput', ptyId: ptyId || '(empty)' })

  if (!ptyId) {
    span.fail('missing ptyId', { method: 'agent.sendInput' })
    orchSpan?.fail('missing ptyId')
    return {
      jsonrpc: '2.0',
      id,
      error: { code: AgentErrorCode.InvalidParams, message: 'Missing ptyId' }
    }
  }

  const entry = PTY_REGISTRY.get(ptyId)
  if (!entry) {
    span.fail('pty-not-found', { ptyId })
    orchSpan?.fail('pty not found', { ptyId })
    return {
      jsonrpc: '2.0',
      id,
      error: { code: AgentErrorCode.PathNotFound, message: `PTY not found: ${ptyId}` }
    }
  }

  try {
    entry.pty.write(data)
    log.info(`agent.sendInput: ptyId=${ptyId} bytes=${data.length}`)
    span.ok({ ptyId, bytes: data.length })
    orchSpan?.ok({ ptyId })
    return { jsonrpc: '2.0', id, result: { ok: true } }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`agent.sendInput failed: ${msg}`)
    span.fail(err, { ptyId })
    orchSpan?.fail(err, { ptyId })
    return { jsonrpc: '2.0', id, error: { code: AgentErrorCode.ServerError, message: msg } }
  }
}

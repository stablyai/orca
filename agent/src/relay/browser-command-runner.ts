// src/relay/browser-command-runner.ts
// Core `agent-browser` CLI execution plumbing for browser.* — resolving the
// vendored binary, running one CLI invocation scoped to a worktree's
// persistent session, and the shared JSON-RPC/param-parsing helpers the
// browser.* handlers build on.
//
// Split out of browser-handler.ts (which is now a re-export barrel) to stay
// under oxlint's max-lines budget. See browser-handler.ts's header comment
// for the full session-scoping/idle-timeout/cleanup model this file
// implements — that context is not repeated here.

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { AgentLogger } from './agent-logger'
import { AgentErrorCode } from '../shared/agent-wire-protocol'

const requireForBrowserHandler = createRequire(__filename)

/**
 * Hand-rolled promise wrapper instead of node:util's promisify(execFile) —
 * execFile has a special promisify.custom implementation that returns
 * {stdout, stderr}; a plain vi.fn() test double loses that annotation, which
 * would silently change what the promisified call resolves to under test.
 * This wrapper's behavior is identical either way and trivially mockable.
 */
function execFileAsync(
  command: string,
  args: string[],
  options: { encoding: 'utf-8'; timeout: number; env: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() })
    })
  })
}

// Why: an idle worktree browser session must not outlive the worktree's
// active use by more than a few minutes — this is a background headless
// Chrome process on a shared dev server host, not a per-user local resource.
const BROWSER_SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000
const BROWSER_COMMAND_TIMEOUT_MS = 30_000

export type JsonRpcId = string | number | null

export type JsonRpcSuccess = {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId
  readonly result: unknown
}

export type JsonRpcError = {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId
  readonly error: { code: number; message: string }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

type BrowserCliEnvelope = {
  success: boolean
  data: unknown
  error: string | null
}

export function makeSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

export function makeFailure(id: JsonRpcId, message: string): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code: AgentErrorCode.ServerError, message } }
}

let cachedBinPath: string | null | undefined

/**
 * Resolves the vendored `agent-browser` CLI entrypoint. Cached because
 * require.resolve() is not free and this is called on every browser.* RPC.
 */
function resolveAgentBrowserBin(): string {
  if (cachedBinPath !== undefined) {
    if (cachedBinPath === null) {
      throw new Error(
        'BROWSER_ENGINE_UNAVAILABLE: the agent-browser package is not installed on this agent — ' +
          'reinstall the Dev Server Agent so its bundled dependencies are present.'
      )
    }
    return cachedBinPath
  }
  try {
    const pkgJsonPath = requireForBrowserHandler.resolve('agent-browser/package.json')
    cachedBinPath = path.join(path.dirname(pkgJsonPath), 'bin', 'agent-browser.js')
    return cachedBinPath
  } catch (err) {
    cachedBinPath = null
    throw new Error(
      `BROWSER_ENGINE_UNAVAILABLE: the agent-browser package is not installed on this agent: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

/** Recognizes agent-browser's own "no usable Chrome/Chromium" failure text. */
function isMissingBrowserEngineError(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('no usable browser') ||
    normalized.includes('could not find') ||
    normalized.includes('failed to launch') ||
    normalized.includes('executable doesn’t exist') ||
    normalized.includes("executable doesn't exist") ||
    normalized.includes('chrome not found') ||
    normalized.includes('browser not found')
  )
}

export type BrowserCommandParams = {
  worktree?: unknown
  page?: unknown
}

export function requireWorktreeId(params: Record<string, unknown>): string {
  const worktreeId = params.worktree
  if (typeof worktreeId !== 'string' || worktreeId.length === 0) {
    throw new Error('BROWSER_NO_WORKTREE: this operation requires a worktree selector')
  }
  return worktreeId
}

/**
 * Runs one `agent-browser` CLI command scoped to a worktree's persistent
 * session, parses its `--json` envelope, and unwraps success/error.
 */
export async function runBrowserCommand(worktreeId: string, args: string[]): Promise<unknown> {
  const bin = resolveAgentBrowserBin()
  const fullArgs = [bin, ...args, '--session', worktreeId, '--json']
  let stdout: string
  try {
    const result = await execFileAsync(process.execPath, fullArgs, {
      encoding: 'utf-8',
      timeout: BROWSER_COMMAND_TIMEOUT_MS,
      env: {
        ...process.env,
        // Why: this file's session-cleanup model — see browser-handler.ts's
        // header comment. Passed on every call since the daemon reads it
        // once, at creation.
        AGENT_BROWSER_IDLE_TIMEOUT_MS: String(BROWSER_SESSION_IDLE_TIMEOUT_MS)
      }
    })
    stdout = result.stdout
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isMissingBrowserEngineError(message)) {
      throw new Error(
        `BROWSER_ENGINE_UNAVAILABLE: no Chrome/Chromium install found on this host for agent-browser to drive. ${message}`
      )
    }
    throw new Error(`BROWSER_COMMAND_FAILED: ${message}`)
  }

  let envelope: BrowserCliEnvelope
  try {
    envelope = JSON.parse(stdout) as BrowserCliEnvelope
  } catch {
    throw new Error(
      `BROWSER_COMMAND_FAILED: agent-browser returned non-JSON output: ${stdout.slice(0, 200)}`
    )
  }
  if (!envelope.success) {
    const message = envelope.error ?? 'unknown agent-browser error'
    if (isMissingBrowserEngineError(message)) {
      throw new Error(`BROWSER_ENGINE_UNAVAILABLE: ${message}`)
    }
    throw new Error(`BROWSER_COMMAND_FAILED: ${message}`)
  }
  return envelope.data
}

export async function dispatchBrowserCommand(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger,
  methodLabel: string,
  buildArgs: (worktreeId: string, params: Record<string, unknown>) => string[],
  shapeResult?: (data: unknown, worktreeId: string) => unknown
): Promise<JsonRpcResponse> {
  try {
    const worktreeId = requireWorktreeId(params)
    const data = await runBrowserCommand(worktreeId, buildArgs(worktreeId, params))
    return makeSuccess(id, shapeResult ? shapeResult(data, worktreeId) : data)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`browser.${methodLabel} failed: ${message}`)
    return makeFailure(id, message)
  }
}

export function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`BROWSER_MISSING_ARGS: '${key}' is required`)
  }
  return value
}

export function numberParam(params: Record<string, unknown>, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`BROWSER_MISSING_ARGS: '${key}' is required`)
  }
  return value
}

export function optionalStringParam(
  params: Record<string, unknown>,
  key: string
): string | undefined {
  const value = params[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function optionalNumberParam(
  params: Record<string, unknown>,
  key: string
): number | undefined {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

import { spawn } from 'child_process'
import type { RelayDispatcher } from './dispatcher'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 5 * 60 * 1000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

type ExecParams = {
  binary: unknown
  args: unknown
  cwd: unknown
  stdin: unknown
  timeoutMs: unknown
  env: unknown
}

type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  /** Set when the binary could not be spawned (e.g. ENOENT). */
  spawnError?: string
}

/**
 * Non-interactive subprocess exec on the remote host. Used by the AI commit
 * message generator to spawn agent CLIs (claude, codex, …) with the staged
 * diff piped via stdin and the output captured to stdout. Distinct from
 * `pty.spawn` because we want no terminal allocation, no escape sequences,
 * and a clean exit code instead of an interactive session.
 */
export class AgentExecHandler {
  constructor(dispatcher: RelayDispatcher) {
    dispatcher.onRequest('agent.execNonInteractive', (p) => this.exec(p as ExecParams))
  }

  private async exec(params: ExecParams): Promise<ExecResult> {
    const binary = typeof params.binary === 'string' ? params.binary : ''
    if (!binary) {
      throw new Error('agent.execNonInteractive: binary is required')
    }
    const args = Array.isArray(params.args) ? params.args.map((a) => String(a)) : []
    const cwd = typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : undefined
    const stdinPayload = typeof params.stdin === 'string' ? params.stdin : null
    const requestedTimeout =
      typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_TIMEOUT_MS
    const timeoutMs = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, requestedTimeout))
    const extraEnv =
      params.env && typeof params.env === 'object' && !Array.isArray(params.env)
        ? (params.env as Record<string, string>)
        : null

    return new Promise<ExecResult>((resolve) => {
      let child
      try {
        child = spawn(binary, args, {
          cwd,
          env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch (error) {
        resolve({
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          spawnError: error instanceof Error ? error.message : String(error)
        })
        return
      }

      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let timedOut = false
      let settled = false
      const finish = (result: ExecResult): void => {
        if (settled) {
          return
        }
        settled = true
        resolve(result)
      }

      const timer = setTimeout(() => {
        timedOut = true
        // Why: SIGKILL because some CLIs trap SIGTERM and continue streaming.
        child.kill('SIGKILL')
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL')
          return
        }
        stdout += chunk.toString('utf-8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength
        if (stderrBytes > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL')
          return
        }
        stderr += chunk.toString('utf-8')
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        finish({
          stdout,
          stderr,
          exitCode: null,
          timedOut,
          spawnError: error.message
        })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        finish({ stdout, stderr, exitCode: code, timedOut })
      })

      if (stdinPayload !== null) {
        child.stdin?.end(stdinPayload)
      } else {
        child.stdin?.end()
      }
    })
  }
}

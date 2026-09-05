import { spawn, type ChildProcess } from 'node:child_process'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { applyTerminalGitCredentialPromptGuard } from '../shared/terminal-git-credential-guard'
import { mergeGitConfigEnvProtocol } from '../shared/git-credential-prompt-env'
import { terminateRelaySubprocessTree } from './subprocess-tree-termination'
import {
  isBareBinaryName,
  isEnoentSpawnError,
  resolvePosixBinaryViaLoginShell
} from './agent-exec-posix-login-shell-resolve'
import { getWindowsSafeSpawn } from './agent-exec-windows-safe-spawn'

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
  operation: unknown
}

type CancelParams = {
  cwd: unknown
  operation: unknown
}

function laneKeyFor(cwd: string, operation: unknown): string {
  const op = typeof operation === 'string' && operation ? operation : 'default'
  return JSON.stringify([op, cwd])
}

type InFlightExec = { child: ChildProcess; cancel: () => void }

type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  /** Set when the user canceled the exec via `agent.cancelExec`. */
  canceled?: boolean
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
  // Why: commit-message and PR-field generation can run together for one cwd;
  // operation lanes let cancel target only the user-visible job that stopped.
  private inFlightByLane = new Map<string, InFlightExec>()

  private laneKey(cwd: string, operation: unknown): string {
    return laneKeyFor(cwd, operation)
  }

  constructor(dispatcher: RelayDispatcher) {
    dispatcher.onRequest('agent.execNonInteractive', (p, context) =>
      this.exec(p as ExecParams, context)
    )
    dispatcher.onRequest('agent.cancelExec', (p) => this.cancel(p as CancelParams))
  }

  private async cancel(params: CancelParams): Promise<{ canceled: boolean }> {
    const cwd = typeof params.cwd === 'string' ? params.cwd : ''
    const entry = this.inFlightByLane.get(this.laneKey(cwd, params.operation))
    if (!entry) {
      return { canceled: false }
    }
    entry.cancel()
    return { canceled: true }
  }

  private async exec(params: ExecParams, context?: RequestContext): Promise<ExecResult> {
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
    const spawnEnv = mergeGitConfigEnvProtocol(process.env, extraEnv ?? undefined) as Record<
      string,
      string
    >
    // Why: this RPC has no interactive terminal, regardless of which wrapper
    // launches the agent or hook command.
    applyTerminalGitCredentialPromptGuard(spawnEnv, {
      isUnattended: true,
      platform: process.platform
    })

    return new Promise<ExecResult>((resolve) => {
      let child: ChildProcess
      const spawnChild = (spawnCmd: string, spawnArgs: string[]): ChildProcess =>
        spawn(spawnCmd, spawnArgs, {
          cwd,
          env: spawnEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      try {
        const { spawnCmd, spawnArgs } = getWindowsSafeSpawn(binary, args, spawnEnv)
        child = spawnChild(spawnCmd, spawnArgs)
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
      let canceled = false
      let settled = false
      let attemptedLoginShellFallback = false
      const laneKey = typeof cwd === 'string' ? this.laneKey(cwd, params.operation) : ''
      let entry: InFlightExec | null = null
      let timer: ReturnType<typeof setTimeout> | null = null
      let detachChildListeners = (): void => {}
      let detachRequestAbortListener = (): void => {}
      const finish = (result: ExecResult): void => {
        if (settled) {
          return
        }
        settled = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        detachRequestAbortListener()
        detachChildListeners()
        if (laneKey && entry && this.inFlightByLane.get(laneKey) === entry) {
          this.inFlightByLane.delete(laneKey)
        }
        resolve(result)
      }
      const cancelCurrent = (): void => {
        canceled = true
        terminateRelaySubprocessTree(child)
      }
      if (laneKey) {
        // Why: the relay owns one visible non-interactive job per cwd+operation.
        // Replacing the lane without canceling the prior child would orphan
        // that process until timeout because future cancelExec calls reach only
        // the newest map entry.
        this.inFlightByLane.get(laneKey)?.cancel()
        entry = {
          child,
          cancel: cancelCurrent
        }
        this.inFlightByLane.set(laneKey, entry)
      }

      timer = setTimeout(() => {
        timedOut = true
        // Why: tree-kill because some CLIs trap SIGTERM and continue streaming;
        // also Windows wraps `.cmd` shims in cmd.exe, so the immediate child
        // is not the real node.exe process.
        terminateRelaySubprocessTree(child)
        finish({ stdout, stderr, exitCode: null, timedOut, canceled })
      }, timeoutMs)

      const onStdoutData = (chunk: Buffer): void => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          terminateRelaySubprocessTree(child)
          return
        }
        stdout += chunk.toString('utf-8')
      }
      const onStderrData = (chunk: Buffer): void => {
        stderrBytes += chunk.byteLength
        if (stderrBytes > MAX_OUTPUT_BYTES) {
          terminateRelaySubprocessTree(child)
          return
        }
        stderr += chunk.toString('utf-8')
      }
      const wireChild = (): void => {
        child.stdout?.on('data', onStdoutData)
        child.stderr?.on('data', onStderrData)
        child.on('error', onError)
        child.on('close', onClose)
        detachChildListeners = () => {
          child.stdout?.off('data', onStdoutData)
          child.stderr?.off('data', onStderrData)
          child.off('error', onError)
          // Why: a late 'error' after we've stopped caring (timeout/cancel/retry)
          // would otherwise have zero listeners and crash the relay process.
          child.on('error', () => {})
          child.off('close', onClose)
        }
        if (entry) {
          entry.child = child
        }
        if (stdinPayload !== null) {
          child.stdin?.end(stdinPayload)
        } else {
          child.stdin?.end()
        }
      }
      const onError = (error: Error): void => {
        const canRetryViaLoginShell =
          !attemptedLoginShellFallback &&
          process.platform !== 'win32' &&
          isBareBinaryName(binary) &&
          isEnoentSpawnError(error)
        if (!canRetryViaLoginShell) {
          finish({ stdout, stderr, exitCode: null, timedOut, spawnError: error.message })
          return
        }
        attemptedLoginShellFallback = true
        detachChildListeners()
        void resolvePosixBinaryViaLoginShell(binary, spawnEnv).then((resolvedPath) => {
          if (settled) {
            return
          }
          if (canceled) {
            finish({ stdout, stderr, exitCode: null, timedOut, canceled })
            return
          }
          if (!resolvedPath) {
            finish({ stdout, stderr, exitCode: null, timedOut, spawnError: error.message })
            return
          }
          try {
            child = spawnChild(resolvedPath, args)
          } catch (retryError) {
            finish({
              stdout,
              stderr,
              exitCode: null,
              timedOut,
              spawnError: retryError instanceof Error ? retryError.message : String(retryError)
            })
            return
          }
          wireChild()
        })
      }
      const onClose = (code: number | null): void => {
        finish({ stdout, stderr, exitCode: code, timedOut, canceled })
      }
      wireChild()

      if (context?.signal) {
        if (context.signal.aborted) {
          cancelCurrent()
        } else {
          context.signal.addEventListener('abort', cancelCurrent, { once: true })
          detachRequestAbortListener = () => {
            context.signal?.removeEventListener('abort', cancelCurrent)
          }
        }
      }
    })
  }
}

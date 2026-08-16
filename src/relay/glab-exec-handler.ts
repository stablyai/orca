import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { terminateRelaySubprocessTree } from './subprocess-tree-termination'

// Why: relay is bundled separately from the app — do not import app-side shared
// modules. Keep this string aligned with src/shared/ssh-types GLAB_EXEC_METHOD.
const GLAB_EXEC_METHOD = 'glab.exec'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 5 * 60 * 1000
// Why: glab api payloads can be large, but unbounded capture OOMs the relay.
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const GLAB_BINARY = 'glab'
const GLAB_ENV_ALLOWLIST = new Map([
  ['gitlab_host', 'GITLAB_HOST'],
  ['gitlab_token', 'GITLAB_TOKEN'],
  ['glab_token', 'GLAB_TOKEN']
])

type GlabExecParams = {
  args: unknown
  cwd: unknown
  timeoutMs: unknown
  env: unknown
}

type GlabExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  /** Set when `glab` could not be spawned (e.g. ENOENT). */
  spawnError?: string
  /** Which stream hit MAX_OUTPUT_BYTES before process close. */
  outputLimitExceeded?: 'stdout' | 'stderr'
}

function pickAllowedGlabEnv(env: Record<string, unknown>): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      continue
    }
    const allowedName = GLAB_ENV_ALLOWLIST.get(key.toLowerCase())
    if (allowedName) {
      picked[allowedName] = value
    }
  }
  return picked
}

/**
 * Hard-allowlisted remote `glab` exec. Distinct from `agent.execNonInteractive`
 * so older relays return method-not-found and the desktop can fall back locally.
 */
export class GlabExecHandler {
  constructor(dispatcher: RelayDispatcher) {
    dispatcher.onRequest(GLAB_EXEC_METHOD, (p, context) => this.exec(p as GlabExecParams, context))
  }

  private async exec(params: GlabExecParams, context?: RequestContext): Promise<GlabExecResult> {
    const args = Array.isArray(params.args) ? params.args.map((a) => String(a)) : []
    const cwd = typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : undefined
    const requestedTimeout =
      typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_TIMEOUT_MS
    const timeoutMs = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, requestedTimeout))
    const extraEnv =
      params.env && typeof params.env === 'object' && !Array.isArray(params.env)
        ? (params.env as Record<string, unknown>)
        : null
    const spawnEnv = {
      ...process.env,
      ...(extraEnv ? pickAllowedGlabEnv(extraEnv) : {})
    } as Record<string, string>

    if (context?.signal?.aborted) {
      return { stdout: '', stderr: '', exitCode: null, timedOut: false }
    }

    return new Promise<GlabExecResult>((resolve) => {
      let child: ChildProcess
      try {
        // Why: argv array only — never shell-interpolate user-controlled strings.
        child = spawn(GLAB_BINARY, args, {
          cwd,
          env: spawnEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false
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
      // Why: multibyte UTF-8 can split across stream chunks; per-chunk toString
      // would inject replacement characters into the captured output.
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')
      let timedOut = false
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let detachChildListeners = (): void => {}
      let detachRequestAbortListener = (): void => {}
      const finish = (result: GlabExecResult): void => {
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
        resolve(result)
      }
      const flushDecoders = (): { stdout: string; stderr: string } => ({
        stdout: stdout + stdoutDecoder.end(),
        stderr: stderr + stderrDecoder.end()
      })
      const cancelCurrent = (): void => {
        terminateRelaySubprocessTree(child)
      }

      timer = setTimeout(() => {
        timedOut = true
        terminateRelaySubprocessTree(child)
        const flushed = flushDecoders()
        finish({ ...flushed, exitCode: null, timedOut })
      }, timeoutMs)

      const onStdoutData = (chunk: Buffer): void => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          // Why: finish inline like timeout — deferred onClose yields exitCode null
          // and "exited with code unknown" with no signal the 4 MiB guard fired.
          terminateRelaySubprocessTree(child)
          const flushed = flushDecoders()
          finish({
            ...flushed,
            exitCode: null,
            timedOut: false,
            outputLimitExceeded: 'stdout'
          })
          return
        }
        stdout += stdoutDecoder.write(chunk)
      }
      const onStderrData = (chunk: Buffer): void => {
        stderrBytes += chunk.byteLength
        if (stderrBytes > MAX_OUTPUT_BYTES) {
          terminateRelaySubprocessTree(child)
          const flushed = flushDecoders()
          finish({
            ...flushed,
            exitCode: null,
            timedOut: false,
            outputLimitExceeded: 'stderr'
          })
          return
        }
        stderr += stderrDecoder.write(chunk)
      }
      const onError = (error: Error): void => {
        const flushed = flushDecoders()
        finish({
          ...flushed,
          exitCode: null,
          timedOut,
          spawnError: error.message
        })
      }
      const onClose = (code: number | null): void => {
        const flushed = flushDecoders()
        finish({ ...flushed, exitCode: code, timedOut })
      }
      child.stdout?.on('data', onStdoutData)
      child.stderr?.on('data', onStderrData)
      child.on('error', onError)
      child.on('close', onClose)
      detachChildListeners = () => {
        child.stdout?.off('data', onStdoutData)
        child.stderr?.off('data', onStderrData)
        child.off('error', onError)
        child.off('close', onClose)
      }

      if (context?.signal) {
        context.signal.addEventListener('abort', cancelCurrent, { once: true })
        detachRequestAbortListener = () => {
          context.signal?.removeEventListener('abort', cancelCurrent)
        }
      }
    })
  }
}

import { execFile, type ChildProcess } from 'node:child_process'
import { BrowserError } from './cdp-bridge'
import { classifyErrorCode } from './agent-browser-bridge-process'
import { AgentBrowserBridgeExecution } from './agent-browser-bridge-execution'
import {
  CONSECUTIVE_TIMEOUT_LIMIT,
  EXEC_TIMEOUT_MS,
  type AgentBrowserExecOptions
} from './agent-browser-bridge-types'

export abstract class AgentBrowserBridgeRawProcess extends AgentBrowserBridgeExecution {
  protected abstract destroySession(
    sessionName: string,
    options?: { closeTimeoutMs?: number }
  ): Promise<void>

  protected runAgentBrowserRaw(
    sessionName: string,
    args: string[],
    execOptions?: AgentBrowserExecOptions
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const session = this.sessions.get(sessionName)
      let child: ChildProcess | null = null
      child = execFile(
        this.agentBrowserBin,
        args,
        // Why: screenshots return large base64 that exceeds Node's default 1MB maxBuffer (ENOBUFS).
        {
          timeout: execOptions?.timeoutMs ?? EXEC_TIMEOUT_MS,
          maxBuffer: 50 * 1024 * 1024,
          // Why windowsHide: see the stale-session close above -- every
          // agent-browser invocation would otherwise flash a console (#14543).
          windowsHide: true,
          env: execOptions?.envOverrides
            ? { ...this.agentBrowserEnv, ...execOptions.envOverrides }
            : this.agentBrowserEnv
        },
        (error, stdout, stderr) => {
          if (session && session.activeProcess === child) {
            session.activeProcess = null
          }
          if (child && this.cancelledProcesses.has(child)) {
            this.cancelledProcesses.delete(child)
            reject(
              new BrowserError('browser_tab_closed', 'Tab was closed while command was running')
            )
            return
          }

          const liveSession = this.sessions.get(sessionName)

          if (error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            if (execOptions?.timeoutError) {
              reject(execOptions.timeoutError)
              return
            }
            if (liveSession) {
              liveSession.consecutiveTimeouts++
              if (liveSession.consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_LIMIT) {
                // Why: 3 consecutive timeouts means the daemon is likely stuck — destroy and recreate
                this.destroySession(sessionName)
              }
            }
            reject(new BrowserError('browser_error', 'Browser command timed out'))
            return
          }

          if (liveSession) {
            liveSession.consecutiveTimeouts = 0
          }

          if (error) {
            // Why: agent-browser exits non-zero on failure but still writes structured JSON to stdout — parse it for the real error.
            if (stdout) {
              try {
                const parsed = JSON.parse(stdout)
                if (parsed.error) {
                  const code = classifyErrorCode(parsed.error)
                  reject(
                    this.createCommandError(sessionName, parsed.error, code, session?.webContentsId)
                  )
                  return
                }
              } catch {
                // stdout not valid JSON — fall through to stderr/error.message
              }
            }
            const message = stderr || error.message
            const code = classifyErrorCode(message)
            reject(this.createCommandError(sessionName, message, code, session?.webContentsId))
            return
          }

          resolve(stdout)
        }
      )
      if (session) {
        session.activeProcess = child
      }
      if (execOptions?.stdinText !== undefined && child?.stdin) {
        // Why: eval --stdin keeps paste-sized scripts out of argv on every platform.
        child.stdin.on('error', () => {})
        child.stdin.end(execOptions.stdinText)
      }
    })
  }
}

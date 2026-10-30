import { execFile, type ChildProcess } from 'node:child_process'
import { BrowserError } from './cdp-bridge'
import { classifyErrorCode } from './agent-browser-bridge-process'
import { parseAgentBrowserJsonOutput } from './agent-browser-batch-command'
import { AgentBrowserBridgeExecution } from './agent-browser-bridge-execution'
import {
  AGENT_BROWSER_EXIT_DRAIN_MS,
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
      let exitDrainTimer: ReturnType<typeof setTimeout> | undefined
      child = execFile(
        this.agentBrowserBin,
        args,
        {
          timeout: execOptions?.timeoutMs ?? EXEC_TIMEOUT_MS,
          maxBuffer: 50 * 1024 * 1024,
          // Hide Windows helper consoles so they cannot take keyboard focus.
          windowsHide: true,
          env: execOptions?.envOverrides
            ? { ...this.agentBrowserEnv, ...execOptions.envOverrides }
            : this.agentBrowserEnv
        },
        (error, stdout, stderr) => {
          clearTimeout(exitDrainTimer)
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
                // Repeated timeouts can indicate a stuck daemon; retire it before reuse.
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
            // Failed helpers can still return a structured error on stdout.
            if (stdout) {
              try {
                const parsed = parseAgentBrowserJsonOutput(stdout)
                if (parsed.error) {
                  const code = classifyErrorCode(parsed.error)
                  reject(
                    this.createCommandError(sessionName, parsed.error, code, session?.webContentsId)
                  )
                  return
                }
              } catch {}
            }
            const message = stderr || error.message
            const code = classifyErrorCode(message)
            reject(this.createCommandError(sessionName, message, code, session?.webContentsId))
            return
          }

          resolve(stdout)
        }
      )
      // Windows daemons inherit stdio; drain after helper exit, then close pipes to settle execFile (vercel-labs/agent-browser#1407).
      child.once('exit', () => {
        exitDrainTimer = setTimeout(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
        }, AGENT_BROWSER_EXIT_DRAIN_MS)
      })
      if (session) {
        session.activeProcess = child
      }
      if (execOptions?.stdinText !== undefined && child?.stdin) {
        child.stdin.on('error', () => {})
        child.stdin.end(execOptions.stdinText)
      }
    })
  }
}

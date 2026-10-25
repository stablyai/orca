import { execFile } from 'node:child_process'
import type { WebContents } from 'electron'
import { BrowserError } from './cdp-bridge'
import {
  focusedRichTextEditExpression,
  isExplicitContentEditableResult
} from './agent-browser-bridge-input'
import {
  isTabClosedTransportError,
  pageUnavailableMessageForSession
} from './agent-browser-bridge-process'
import { translateResult } from './agent-browser-bridge-result'
import { AgentBrowserBridgeTabs } from './agent-browser-bridge-tabs'
import { assertRemoteCliBrowserAccess } from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import { canSkipAgentBrowserSessionReset } from './agent-browser-session-reset'
import {
  STALE_SESSION_CLOSE_TIMEOUT_MS,
  type AgentBrowserExecOptions,
  type SessionState,
  type ResolvedBrowserCommandTarget
} from './agent-browser-bridge-types'

export abstract class AgentBrowserBridgeExecution extends AgentBrowserBridgeTabs {
  protected abstract destroySession(
    sessionName: string,
    options?: { closeTimeoutMs?: number }
  ): Promise<void>

  protected abstract runAgentBrowserRaw(
    sessionName: string,
    args: string[],
    execOptions?: AgentBrowserExecOptions
  ): Promise<string>

  protected requireTargetWebContents(target: ResolvedBrowserCommandTarget): WebContents {
    const wc = this.getWebContents(target.webContentsId)
    if (!wc || wc.isDestroyed()) {
      throw this.createPageUnavailableError(`${ORCA_TAB_SESSION_PREFIX}${target.browserPageId}`)
    }
    return wc
  }

  /** Idle retirement loses daemon routes; restore them when its replacement connects. */
  protected reinitializeIfDaemonIdledOut(sessionName: string, session: SessionState): void {
    if (
      this.agentBrowserIdleTimeoutMs === null ||
      Date.now() - session.lastCommandAt < this.agentBrowserIdleTimeoutMs
    ) {
      return
    }
    session.initialized = false
    if (session.activeInterceptPatterns.length > 0) {
      this.pendingInterceptRestore.set(sessionName, [...session.activeInterceptPatterns])
    }
  }

  protected assertCommandAdmission(): void {
    if (this.shutdownStarted) {
      throw new BrowserError('browser_owner_unavailable', 'Browser runtime is shutting down')
    }
  }

  protected async execAgentBrowser(
    sessionName: string,
    commandArgs: string[],
    execOptions?: AgentBrowserExecOptions
  ): Promise<unknown> {
    const session = this.sessions.get(sessionName)
    if (!session) {
      throw this.createPageUnavailableError(sessionName)
    }

    // The target may disappear while the command waits in the queue.
    if (!this.getWebContents(session.webContentsId)) {
      await this.destroySession(sessionName)
      throw this.createPageUnavailableError(sessionName)
    }

    // Recheck revocation before each helper spawn within a command.
    assertRemoteCliBrowserAccess(session.webContentsId)
    this.reinitializeIfDaemonIdledOut(sessionName, session)
    session.lastCommandAt = Date.now()

    const args = ['--session', sessionName]
    const managesInterceptRoutes =
      commandArgs[0] === 'network' && (commandArgs[1] === 'route' || commandArgs[1] === 'unroute')

    const needsInit = !session.initialized
    // Every invocation must pin CDP ownership or a restarted daemon may launch Chrome.
    args.push('--cdp', String(session.proxy.getPort()))

    // Spreading large passthrough argv can exceed V8's argument limit.
    for (const commandArg of commandArgs) {
      args.push(commandArg)
    }
    args.push('--json')

    const stdout = await this.runAgentBrowserRaw(sessionName, args, execOptions)
    const translated = translateResult(stdout)

    if (!translated.ok) {
      throw this.createCommandError(
        sessionName,
        translated.error.message,
        translated.error.code,
        session.webContentsId
      )
    }

    if (needsInit) {
      session.initialized = true

      // Restore routes lost on process swap unless this command reconfigures them.
      const pendingPatterns = managesInterceptRoutes
        ? undefined
        : this.pendingInterceptRestore.get(sessionName)
      if (pendingPatterns && pendingPatterns.length > 0) {
        this.pendingInterceptRestore.delete(sessionName)
        try {
          const urlPattern = pendingPatterns[0] ?? '**/*'
          await this.runAgentBrowserRaw(sessionName, [
            '--session',
            sessionName,
            '--cdp',
            String(session.proxy.getPort()),
            'network',
            'route',
            urlPattern,
            '--json'
          ])
          session.activeInterceptPatterns = pendingPatterns
        } catch {
          // Route restoration must not fail an otherwise successful command.
        }
      }
    }

    return translated.result
  }

  protected async isExplicitContentEditableTarget(
    sessionName: string,
    element: string
  ): Promise<boolean> {
    const result = await this.execAgentBrowser(sessionName, [
      'get',
      'attr',
      element,
      'contenteditable'
    ])
    return isExplicitContentEditableResult(result)
  }

  protected async fillExplicitContentEditable(
    sessionName: string,
    element: string,
    value: string
  ): Promise<void> {
    await this.execAgentBrowser(sessionName, ['focus', element])
    // Send one stdin edit to avoid argv limits and focus changes between chunks.
    await this.execAgentBrowser(sessionName, ['eval', '--stdin'], {
      stdinText: focusedRichTextEditExpression(JSON.stringify(value), { selectAll: true })
    })
  }

  protected createPageUnavailableError(sessionName: string): BrowserError {
    return new BrowserError('browser_tab_not_found', pageUnavailableMessageForSession(sessionName))
  }

  protected closeStaleAgentBrowserSession(sessionName: string): Promise<void> {
    if (
      canSkipAgentBrowserSessionReset({
        ownsSocketDirectory: this.ownsAgentBrowserSocketDirectory,
        socketDirectory: this.agentBrowserEnv.AGENT_BROWSER_SOCKET_DIR,
        sessionName
      })
    ) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof execFile> | null = null
      let settled = false

      const finish = (error?: Error): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }

      // Reusing an unverified stale daemon could target an unrelated browser.
      const timeout = setTimeout(() => {
        child?.kill()
        finish(
          new BrowserError(
            'browser_owner_unavailable',
            `Could not reset stale helper session ${sessionName}; retry after agent-browser exits`
          )
        )
      }, STALE_SESSION_CLOSE_TIMEOUT_MS)

      try {
        child = execFile(
          this.agentBrowserBin,
          ['--session', sessionName, 'close'],
          // Hide Windows helper consoles so they cannot take keyboard focus.
          {
            env: this.agentBrowserEnv,
            timeout: STALE_SESSION_CLOSE_TIMEOUT_MS,
            windowsHide: true
          },
          (error) =>
            finish(
              error
                ? new BrowserError(
                    'browser_owner_unavailable',
                    `Could not reset stale helper session ${sessionName}: ${error.message}`
                  )
                : undefined
            )
        )
      } catch (error) {
        finish(
          new BrowserError(
            'browser_owner_unavailable',
            `Could not reset stale helper session ${sessionName}: ${error instanceof Error ? error.message : String(error)}`
          )
        )
      }
    })
  }

  protected createCommandError(
    sessionName: string,
    message: string,
    fallbackCode: string,
    webContentsId?: number
  ): BrowserError {
    // Connection refusal proves page loss only when the target is also gone.
    if (
      fallbackCode === 'browser_error' &&
      isTabClosedTransportError(message) &&
      this.isSessionTargetClosed(sessionName, webContentsId)
    ) {
      return this.createPageUnavailableError(sessionName)
    }
    return new BrowserError(fallbackCode, message)
  }

  protected isSessionTargetClosed(sessionName: string, webContentsId?: number): boolean {
    const session = this.sessions.get(sessionName)
    if (!session) {
      return true
    }
    const targetWebContentsId = webContentsId ?? session.webContentsId
    return !this.getWebContents(targetWebContentsId)
  }
}

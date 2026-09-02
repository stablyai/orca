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
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
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

  /**
   * Notice that the daemon retired itself between two commands.
   *
   * A replacement daemon still serves the page (every call reasserts `--cdp`)
   * but carries none of the session's network routes, so without this the
   * interception the caller configured is silently gone (#16367).
   */
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
      // Why: a queued command can run after a concurrent close deleted the session — surface a tab-lifecycle error, not an opaque failure.
      throw this.createPageUnavailableError(sessionName)
    }

    // Why: the webContents can be destroyed during queue delay — check here to avoid cryptic Electron debugger errors.
    if (!this.getWebContents(session.webContentsId)) {
      await this.destroySession(sessionName)
      throw this.createPageUnavailableError(sessionName)
    }

    this.reinitializeIfDaemonIdledOut(sessionName, session)
    session.lastCommandAt = Date.now()

    const args = ['--session', sessionName]
    const managesInterceptRoutes =
      commandArgs[0] === 'network' && (commandArgs[1] === 'route' || commandArgs[1] === 'unroute')

    const needsInit = !session.initialized
    // Why: a restarted named daemon auto-launches Chrome unless every invocation reasserts Orca's CDP owner.
    args.push('--cdp', String(session.proxy.getPort()))

    // Why: exec passthrough can produce a large argv; spreading into push risks V8 argument limits.
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

    // Why: mark initialized only after success, so a failed first --cdp connection retries with --cdp.
    if (needsInit) {
      session.initialized = true

      // Why: a process swap loses intercept patterns — restore them now unless the caller's first command reconfigured routing.
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
          // Why: intercept restore is best-effort — don't fail the user's command if the new page can't support it.
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
    // Why: stdin avoids argv limits and keeps replacement atomic; chunked edits can move focus and split a fill across controls.
    await this.execAgentBrowser(sessionName, ['eval', '--stdin'], {
      stdinText: focusedRichTextEditExpression(JSON.stringify(value), { selectAll: true })
    })
  }

  protected createPageUnavailableError(sessionName: string): BrowserError {
    return new BrowserError('browser_tab_not_found', pageUnavailableMessageForSession(sessionName))
  }

  protected closeStaleAgentBrowserSession(sessionName: string): Promise<void> {
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

      // Why: proceeding after an unverified close can reuse a daemon that owns an unrelated browser.
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
          // Why windowsHide: agent-browser is console-subsystem and Orca's main
          // process owns no console, so each spawn gets a fresh visible conhost
          // that takes foreground -- keystrokes typed into a terminal at that
          // moment land in the black box (#14543).
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
    // Why: CDP "connection refused" can also mean a real proxy failure — only map to closed-page when the target is confirmed gone.
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

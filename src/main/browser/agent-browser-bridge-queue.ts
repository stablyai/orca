import type { BrowserTabSwitchResult } from '../../shared/runtime-types'
import { BrowserError } from './cdp-bridge'
import { AgentBrowserBridgeActionEffects } from './agent-browser-bridge-action-effects'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import type {
  EnqueueTargetedCommandOptions,
  ResolvedBrowserCommandTarget
} from './agent-browser-bridge-types'
import { runWithRemoteCliPageAdmission } from './remote-cli-page-admission'
import { runWithActionEffects } from './agent-browser-action-effects'
import { AGENT_BROWSER_CLEANUP_TIMEOUT_MS } from './agent-browser-bridge-types'
import { releaseHeldPageInput } from './guest-direct-key-input'
import { onBrowserJavaScriptDialogOpened } from './browser-javascript-dialogs'
import {
  assertNoJavaScriptDialog,
  dialogAnswerHint,
  quoteDialogMessage
} from './agent-browser-dialog-errors'
import {
  captureRemoteCliBrowserRevocation,
  captureRemoteCliBrowserScope,
  runOutsideRemoteCliBrowserScope
} from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'

export abstract class AgentBrowserBridgeQueue extends AgentBrowserBridgeActionEffects {
  // Serialize tab switches behind commands targeting the current tab.
  async tabSwitch(
    index: number | undefined,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserTabSwitchResult> {
    return this.enqueueCommand(worktreeId, async () => {
      const tabs = this.getRegisteredTabs(worktreeId)
      // The tab list may change while this switch waits in the queue.
      const liveEntries = [...tabs.entries()].filter(([, wcId]) => this.getWebContents(wcId))
      let switchedIndex = index ?? -1
      let resolvedPageId = browserPageId
      if (resolvedPageId) {
        switchedIndex = liveEntries.findIndex(([tabId]) => tabId === resolvedPageId)
      }
      if (switchedIndex < 0 || switchedIndex >= liveEntries.length) {
        const targetLabel =
          resolvedPageId != null ? `Browser page ${resolvedPageId}` : `Tab index ${index}`
        throw new BrowserError(
          'browser_tab_not_found',
          `${targetLabel} out of range (0-${liveEntries.length - 1})`
        )
      }
      const [tabId, wcId] = liveEntries[switchedIndex]
      const owningWorktreeId = worktreeId ?? this.browserManager.getWorktreeIdForTab(tabId)
      // Page-only switches must also update the owning workspace for later scoped commands.
      this.pointAgentAt(wcId, owningWorktreeId ?? undefined)
      this.options.onTabsChanged?.(owningWorktreeId ?? undefined)
      return { switched: switchedIndex, browserPageId: tabId }
    })
  }

  protected async enqueueCommand<T>(
    worktreeId: string | undefined,
    execute: (sessionName: string) => Promise<T>
  ): Promise<T> {
    return this.enqueueTargetedCommand(worktreeId, undefined, execute)
  }

  /** A command that acts on the page; an agent's gets the effects it caused added to its result. */
  protected enqueuePageAction<T>(
    worktreeId: string | undefined,
    browserPageId: string | undefined,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions = {}
  ): Promise<T> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, execute, {
      ...options,
      reportEffects: options.reportEffects !== false
    })
  }

  protected async enqueueTargetedCommand<T>(
    worktreeId: string | undefined,
    browserPageId: string | undefined,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions = {}
  ): Promise<T> {
    this.assertCommandAdmission()
    const assertNotRevoked = captureRemoteCliBrowserRevocation()
    const origin = captureRemoteCliBrowserScope()
    assertNotRevoked()
    const { browserPageId: pageId, webContentsId } = this.resolveCommandTarget(
      worktreeId,
      browserPageId,
      options.requireScopedTarget
    )
    if (!browserPageId && options.elements) {
      this.assertRefsFromPage(pageId, options.elements)
    }
    // Fail before queueing: the turn ahead may be a command waiting on this very dialog.
    assertNoJavaScriptDialog(webContentsId, pageId, assertNotRevoked)
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${pageId}`
    const agentCommand = this.browserManager.beginAgentCommand(pageId)
    // Decided at enqueue: a queued command runs under the caller of the command ahead of it.
    const reportEffects = options.reportEffects === true && agentCommand.agent

    // A dialog blocks the page until it is answered. A command still waiting never runs; one
    // already running answers its caller now and keeps its turn until it ends, so nothing overtakes it.
    let running = false
    let interrupted = false
    // A started command ends the lease when it finishes; a dropped one when it settles.
    let started = false
    let stopWatching = (): void => {}
    return new Promise<T>((resolve, reject) => {
      let queue = this.commandQueues.get(sessionName)
      if (!queue) {
        queue = []
        this.commandQueues.set(sessionName, queue)
      }
      const pageQueue = queue
      const entry = {
        execute: () => {
          assertNotRevoked()
          const run = (): Promise<T> =>
            this.executeQueuedCommand(
              worktreeId,
              pageId,
              (session, target) => {
                const gate = (): void => assertNotRevoked(target.webContentsId)
                gate()
                if (interrupted) {
                  throw new BrowserError(
                    'browser_dialog_opened',
                    'A dialog interrupted this command'
                  )
                }
                assertNoJavaScriptDialog(target.webContentsId, pageId, gate)
                if (target.webContentsId !== webContentsId) {
                  // The page got a replacement guest while this command waited.
                  const stopWatchingQueued = stopWatching
                  const stopWatchingTarget = watch(target.webContentsId)
                  stopWatching = () => {
                    stopWatchingQueued()
                    stopWatchingTarget()
                  }
                }
                running = true
                const act = (): Promise<T> =>
                  reportEffects
                    ? runWithActionEffects(
                        this.actionEffectsHost(worktreeId, pageId, session),
                        () => execute(session, target)
                      )
                    : execute(session, target)
                return origin.bridged
                  ? this.runHostCommand(session, target.webContentsId, gate, origin, act)
                  : act()
              },
              options
            )
          return origin.run(() => {
            started = true
            return agentCommand.run(run)
          })
        },
        resolve: resolve as (value: unknown) => void,
        reject
      }
      const watch = (guestId: number): (() => void) =>
        onBrowserJavaScriptDialogOpened(guestId, (dialog) => {
          const waitingAt = pageQueue.indexOf(entry)
          if (waitingAt !== -1) {
            pageQueue.splice(waitingAt, 1)
          }
          interrupted = true
          try {
            assertNotRevoked(guestId)
          } catch (error) {
            reject(error)
            return
          }
          const opened = `The page opened a JavaScript ${dialog.type}: ${quoteDialogMessage(dialog)}.`
          const effect = running
            ? "The command may already have taken effect, so don't repeat it."
            : 'The command did not run.'
          reject(
            new BrowserError(
              'browser_dialog_opened',
              `${opened} ${effect} ${dialogAnswerHint(dialog, pageId)}.`
            )
          )
        })
      pageQueue.push(entry)
      stopWatching = watch(webContentsId)
      this.processQueue(sessionName)
    }).finally(() => {
      stopWatching()
      if (!started) {
        agentCommand.end()
      }
    })
  }

  protected async executeQueuedCommand<T>(
    worktreeId: string | undefined,
    browserPageId: string,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions
  ): Promise<T> {
    this.assertCommandAdmission()
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${browserPageId}`
    // A queued page may acquire a replacement guest before execution.
    const target = this.resolveCommandTarget(worktreeId, browserPageId)
    const releaseGuest = this.browserManager.holdGuestActive(target.webContentsId)
    try {
      if (options.ensureSession !== false) {
        await this.ensureSession(sessionName, browserPageId, target.webContentsId)
      }
      return await execute(sessionName, target)
    } finally {
      releaseGuest()
    }
  }

  /** Revocation must stop every later step of a host command. */
  private runHostCommand<T>(
    sessionName: string,
    webContentsId: number,
    gate: () => void,
    { revoked, hostRevoked }: { revoked?: AbortSignal; hostRevoked?: AbortSignal },
    execute: () => Promise<T>
  ): Promise<T> {
    return runWithRemoteCliPageAdmission(webContentsId, gate, execute, {
      revoked,
      hostRevoked,
      inPageTurn: (work) => this.enqueueDesktopPageWork(sessionName, work),
      retire: () =>
        this.destroySession(sessionName, {
          closeTimeoutMs: AGENT_BROWSER_CLEANUP_TIMEOUT_MS,
          keepQueuedCommands: true
        }),
      releaseHeld: (release) => {
        const wc = this.getWebContents(webContentsId)
        return wc
          ? releaseHeldPageInput(wc, release, () =>
              this.browserManager.guardUserFocusForAgentInput(webContentsId)
            )
          : Promise.resolve()
      }
    })
  }

  /** Serialize desktop cleanup with commands on the same page. */
  private enqueueDesktopPageWork(sessionName: string, work: () => Promise<void>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let queue = this.commandQueues.get(sessionName)
      if (!queue) {
        queue = []
        this.commandQueues.set(sessionName, queue)
      }
      queue.push({
        execute: () => runOutsideRemoteCliBrowserScope(work),
        resolve,
        reject
      })
      void this.processQueue(sessionName)
    })
  }

  protected async processQueue(sessionName: string): Promise<void> {
    if (this.processingQueues.has(sessionName)) {
      return
    }
    this.processingQueues.add(sessionName)

    const queue = this.commandQueues.get(sessionName)
    while (queue && queue.length > 0) {
      const cmd = queue.shift()!
      try {
        const result = await cmd.execute()
        cmd.resolve(result)
      } catch (error) {
        cmd.reject(error)
      }
    }

    if (queue && queue.length === 0 && this.commandQueues.get(sessionName) === queue) {
      this.commandQueues.delete(sessionName)
    }
    this.processingQueues.delete(sessionName)
  }
}

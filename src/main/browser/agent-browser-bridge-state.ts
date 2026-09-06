import { app } from 'electron'
import type { ChildProcess } from 'node:child_process'
import type { BrowserManager } from './browser-manager'
import { createAgentBrowserProcessEnvironment } from './agent-browser-process-environment'
import { resolveAgentBrowserBinary } from './agent-browser-bridge-process'
import type {
  AgentBrowserBridgeOptions,
  QueuedCommand,
  SessionState
} from './agent-browser-bridge-types'

export abstract class AgentBrowserBridgeState {
  // Why: per-worktree active tab so one worktree's tab switch can't affect another's command targeting.
  protected readonly activeWebContentsPerWorktree = new Map<string, number>()
  protected activeWebContentsId: number | null = null
  protected readonly sessions = new Map<string, SessionState>()
  protected readonly commandQueues = new Map<string, QueuedCommand[]>()
  protected readonly processingQueues = new Set<string>()
  // Why: screenshot prep mutates shared paintability across tabs; serialize globally so concurrent captures don't blank each other.
  protected screenshotTurn: Promise<void> = Promise.resolve()
  protected readonly agentBrowserBin: string
  protected readonly agentBrowserEnv: NodeJS.ProcessEnv
  protected readonly ownsAgentBrowserSocketDirectory: boolean
  // Why: null when nothing bounds the daemon, so the bridge never guesses that one was replaced.
  protected readonly agentBrowserIdleTimeoutMs: number | null
  // Why: stash intercept patterns from a swap-destroyed session, keyed by name, so the next session restores them.
  protected readonly pendingInterceptRestore = new Map<string, string[]>()
  // Why: promise-lock so two concurrent ensureSession calls don't both create the session entry.
  protected readonly pendingSessionCreation = new Map<string, Promise<void>>()
  // Why: `agent-browser close` is async, keyed by session name — recreating before it finishes lets the old teardown close the new session.
  protected readonly pendingSessionDestruction = new Map<string, Promise<void>>()
  protected readonly cancelledProcesses = new WeakSet<ChildProcess>()
  protected shutdownStarted = false

  constructor(
    protected readonly browserManager: BrowserManager,
    protected readonly options: AgentBrowserBridgeOptions = {}
  ) {
    this.agentBrowserBin = resolveAgentBrowserBinary()
    const processEnvironment = createAgentBrowserProcessEnvironment({
      inheritedEnv: process.env,
      platform: process.platform,
      userDataPath: app.getPath('userData')
    })
    this.agentBrowserEnv = processEnvironment.env
    this.ownsAgentBrowserSocketDirectory = processEnvironment.ownsSocketDirectory
    const idleTimeoutMs = Number(this.agentBrowserEnv.AGENT_BROWSER_IDLE_TIMEOUT_MS)
    this.agentBrowserIdleTimeoutMs = idleTimeoutMs > 0 ? idleTimeoutMs : null
  }

  protected resolveTabIdSafe(webContentsId: number): string | null {
    return this.browserManager.getTabIdForWebContentsId(webContentsId)
  }

  protected getWebContents(webContentsId: number): Electron.WebContents | null {
    try {
      const { webContents } = require('electron')
      const target = webContents.fromId(webContentsId)
      return target && !target.isDestroyed() ? target : null
    } catch {
      return null
    }
  }
}

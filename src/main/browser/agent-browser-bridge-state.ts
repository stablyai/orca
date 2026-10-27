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
  // Isolate each worktree's tab selection.
  protected readonly activeWebContentsPerWorktree = new Map<string, number>()
  protected activeWebContentsId: number | null = null
  protected readonly sessions = new Map<string, SessionState>()
  protected readonly commandQueues = new Map<string, QueuedCommand[]>()
  protected readonly processingQueues = new Set<string>()
  protected readonly agentBrowserBin: string
  protected readonly agentBrowserEnv: NodeJS.ProcessEnv
  protected readonly ownsAgentBrowserSocketDirectory: boolean
  // Null disables idle-replacement detection when daemon lifetime is unbounded.
  protected readonly agentBrowserIdleTimeoutMs: number | null
  // Restore routes after a process swap destroys the session.
  protected readonly pendingInterceptRestore = new Map<string, string[]>()
  protected readonly pendingSessionCreation = new Map<string, Promise<void>>()
  // Await the old close before reusing its session name, or it can close the replacement.
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

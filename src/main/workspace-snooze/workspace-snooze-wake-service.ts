import { isWorkspaceSnoozeDue, type WorkspaceSnooze } from '../../shared/workspace-snooze'
import { subscribeSystemPowerLifecycle } from '../system-power-lifecycle'

export type SnoozedWorkspace = {
  kind: 'worktree' | 'folder-workspace'
  id: string
  snooze: WorkspaceSnooze
}

export type WorkspaceSnoozeWakeDeps = {
  listSnoozed: () => SnoozedWorkspace[]
  /** Clears the snooze and surfaces the workspace as unread. */
  wake: (workspace: SnoozedWorkspace, now: number) => Promise<void>
  now?: () => number
  tickMs?: number
}

// Why 30s: presets are hours apart, so this only bounds how late a picked time can fire.
const DEFAULT_TICK_MS = 30 * 1000

/**
 * Wakes snoozed workspaces whose time has passed. Runs in the process that owns the
 * metadata, so wake happens with every window closed and on headless hosts.
 */
export class WorkspaceSnoozeWakeService {
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribePower: (() => void) | null = null
  private running: Promise<void> | null = null
  private rerunRequested = false
  private readonly now: () => number
  private readonly tickMs: number

  constructor(private readonly deps: WorkspaceSnoozeWakeDeps) {
    this.now = deps.now ?? Date.now
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS
  }

  start(): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => void this.wakeDue(), this.tickMs)
    // Why: interval timers stall across OS sleep, so wake on resume too. Subscribing
    // while awake fires onResume at once, which doubles as the startup catch-up pass.
    this.unsubscribePower = subscribeSystemPowerLifecycle({
      onSuspend: () => {},
      onResume: () => void this.wakeDue()
    })
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.unsubscribePower?.()
    this.unsubscribePower = null
  }

  /** A call during a pass queues one more, since the running pass already read the clock. */
  wakeDue(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true
      return this.running
    }
    this.running = this.runPasses().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async runPasses(): Promise<void> {
    do {
      this.rerunRequested = false
      await this.runPass()
    } while (this.rerunRequested)
  }

  private async runPass(): Promise<void> {
    const now = this.now()
    let snoozed: SnoozedWorkspace[]
    try {
      snoozed = this.deps.listSnoozed()
    } catch (error) {
      // Why warn and not throw: callers fire passes with `void`, and the next pass retries the read.
      console.warn('[workspace-snooze] Failed to list snoozed workspaces:', error)
      return
    }
    const due = snoozed.filter((ws) => isWorkspaceSnoozeDue(ws.snooze, now))
    for (const workspace of due) {
      try {
        await this.deps.wake(workspace, now)
      } catch (error) {
        // Why keep going: one unreachable host must not hold back every other wake; the next pass retries it.
        console.warn(`[workspace-snooze] Failed to wake ${workspace.kind} ${workspace.id}:`, error)
      }
    }
  }
}

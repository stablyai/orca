export type QuitTaskPhase =
  | 'before-quit-update'
  | 'cloud-sessions'
  | 'ref-maintenance'
  | 'history-gc'
  | 'tcc-notice'
  | 'will-quit-update'
  | 'tray'
  | 'codex-backfill'
  | 'codex-bridges'
  | 'structured-sessions'
  | 'structured-record-store'
  | 'dock'
  | 'worktree-removals'
  | 'hook-server'
  | 'grok-hooks'
  | 'wsl-relays'
  | 'local-ssh-browser-routes'
  | 'browser-guests'
  | 'ssh'
  | 'pty'
  | 'folder-watchers'
  | 'filesystem-watchers'
  | 'base-directory-watchers'
  | 'desktop-browser-bridge'
  | 'browser-client-hosts'
  | 'runtime-rpc-stopped'
  | 'daemon'
  | 'telemetry'
  | 'observability'

export type QuitTaskContext = {
  isUpdate: boolean
  shutdownDaemon: boolean
}

type QuitTask = (context: QuitTaskContext) => void | Promise<unknown>

export class QuitTaskRegistry {
  private readonly phases = new Map<QuitTaskPhase, Map<string, QuitTask>>()
  private readonly startedPhases = new Set<QuitTaskPhase>()

  hasStarted(phase: QuitTaskPhase): boolean {
    return this.startedPhases.has(phase)
  }

  register(phase: QuitTaskPhase, name: string, task: QuitTask): () => void {
    let tasks = this.phases.get(phase)
    if (!tasks) {
      tasks = new Map()
      this.phases.set(phase, tasks)
    }
    tasks.set(name, task)
    return () => {
      if (tasks.get(name) === task) {
        tasks.delete(name)
      }
    }
  }

  // Invoke before returning: SSH detach and the final save must share one synchronous turn.
  run(phase: QuitTaskPhase, context: QuitTaskContext): Promise<void> {
    this.startedPhases.add(phase)
    const pending: Promise<unknown>[] = []
    for (const [name, task] of this.phases.get(phase) ?? []) {
      try {
        pending.push(
          Promise.resolve(task(context)).catch((error: unknown) => {
            console.error(`[shutdown] ${name} failed:`, error)
          })
        )
      } catch (error) {
        console.error(`[shutdown] ${name} failed:`, error)
      }
    }
    return Promise.all(pending).then(() => {})
  }
}

const quitTasks = new QuitTaskRegistry()

export const registerQuitTask = quitTasks.register.bind(quitTasks)
export const runQuitTasks = quitTasks.run.bind(quitTasks)
export const hasQuitTaskPhaseStarted = quitTasks.hasStarted.bind(quitTasks)

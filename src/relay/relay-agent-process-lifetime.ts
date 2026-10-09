import { terminateRelaySubprocessTree } from './subprocess-tree-termination'

type Child = Parameters<typeof terminateRelaySubprocessTree>[0]

// Why 10s: the same physical-exit deadline the relay's watcher children get after a kill.
export const RELAY_AGENT_CLOSE_DEADLINE_MS = 10_000
// Why: output still buffered when the child exits drains well inside this; anything later comes
// from a background process that inherited the pipes, which the exec does not own.
export const RELAY_AGENT_EXIT_PIPE_DRAIN_MS = 1_000

/** Request timeout/cancellation is not evidence that its host child has closed. */
export class RelayAgentProcessLifetime {
  private fenced = false
  private readonly children = new Map<Child, Promise<void>>()
  // Why: a retry re-checks close instead of re-killing a tree whose pid may already be reused.
  private readonly signalled = new WeakSet<Child>()
  private disposal: Promise<void> | null = null

  constructor(
    private readonly closeDeadlineMs = RELAY_AGENT_CLOSE_DEADLINE_MS,
    private readonly exitPipeDrainMs = RELAY_AGENT_EXIT_PIPE_DRAIN_MS
  ) {}

  assertAdmission(): void {
    if (this.fenced) {
      throw new Error('relay_agent_execution_shutdown_fenced')
    }
  }

  /** Never throws: a child that slipped past a fence is killed, but still tracked to its close. */
  track(child: Child): void {
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    this.children.set(child, closed)
    // A late error after request timeout must not remove physical-close tracking or crash the host.
    const onError = () => {}
    child.on('error', onError)
    // Exit is the physical-exit proof; a descendant holding the pipes must not keep 'close' away,
    // so after a bounded drain the relay lets go of them, which emits 'close' for every listener.
    let drain: ReturnType<typeof setTimeout> | undefined
    child.once('exit', () => {
      drain = setTimeout(() => {
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          stream?.destroy()
        }
      }, this.exitPipeDrainMs)
      drain.unref?.()
    })
    child.once('close', () => {
      clearTimeout(drain)
      child.off('error', onError)
      this.children.delete(child)
      resolveClosed()
    })
    if (this.fenced) {
      this.signalled.add(child)
      terminateRelaySubprocessTree(child)
    }
  }

  reopen(): void {
    this.fenced = false
  }

  dispose(): Promise<void> {
    this.fenced = true
    if (this.disposal) {
      return this.disposal
    }
    const pending = [...this.children.entries()]
    for (const [child] of pending) {
      if (!this.signalled.has(child)) {
        this.signalled.add(child)
        terminateRelaySubprocessTree(child)
      }
    }
    const disposal = this.waitForClose(pending.map(([, closed]) => closed)).finally(() => {
      this.disposal = null
    })
    this.disposal = disposal
    return disposal
  }

  private waitForClose(closes: Promise<void>[]): Promise<void> {
    if (closes.length === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('relay_agent_execution_shutdown_incomplete'))
      }, this.closeDeadlineMs)
      timer.unref?.()
      void Promise.all(closes).then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

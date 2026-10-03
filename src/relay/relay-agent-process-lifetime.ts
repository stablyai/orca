import { terminateRelaySubprocessTree } from './subprocess-tree-termination'

type Child = Parameters<typeof terminateRelaySubprocessTree>[0]

// Why 10s: the same physical-exit deadline the relay's watcher children get after a kill.
export const RELAY_AGENT_CLOSE_DEADLINE_MS = 10_000

/** Request timeout/cancellation is not evidence that its host child has closed. */
export class RelayAgentProcessLifetime {
  private fenced = false
  private readonly children = new Map<Child, Promise<void>>()
  // Why: a retry re-checks close instead of re-killing a tree whose pid may already be reused.
  private readonly signalled = new WeakSet<Child>()
  private disposal: Promise<void> | null = null

  constructor(private readonly closeDeadlineMs = RELAY_AGENT_CLOSE_DEADLINE_MS) {}

  assertAdmission(): void {
    if (this.fenced) {
      throw new Error('relay_agent_execution_shutdown_fenced')
    }
  }

  track(child: Child): void {
    this.assertAdmission()
    // Why: no Promise.withResolvers — the relay bundle still targets Node 18 hosts.
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    this.children.set(child, closed)
    // A late error after request timeout must not remove physical-close tracking or crash the host.
    const onError = () => {}
    child.on('error', onError)
    child.once('close', () => {
      child.off('error', onError)
      this.children.delete(child)
      resolveClosed()
    })
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

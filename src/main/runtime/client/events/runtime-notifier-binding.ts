import type { RuntimeNotifier } from './runtime-notifier-contract'
import { OrcaRuntimeWithPtyController } from '../../terminal/lifecycle/orca-runtime-pty-controller'

export abstract class RuntimeNotifierBinding extends OrcaRuntimeWithPtyController {
  setNotifier(notifier: RuntimeNotifier | null): void {
    this.notifier = notifier
    if (notifier) {
      this.repositoryForkBackfill.start()
      queueMicrotask(() => this.retrySleptMailboxWakes())
    }
  }

  protected countTerminalSideEffectConsumingClientEventListeners(): number {
    return this.clientEvents.countTerminalSideEffectConsumers()
  }
}

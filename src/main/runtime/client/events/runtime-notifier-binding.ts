import type { RuntimeNotifier } from './runtime-notifier-contract'
import { activeCallMayTouchHostTabs } from '../../session-tabs/person/host-tab-list-admission'
import { guardNotifierForTeammates, hostWindowLookups } from './teammate-host-window-guard'
import { OrcaRuntimeWithPtyController } from '../../terminal/lifecycle/orca-runtime-pty-controller'

export abstract class RuntimeNotifierBinding extends OrcaRuntimeWithPtyController {
  setNotifier(notifier: RuntimeNotifier | null): void {
    this.notifier = notifier
      ? guardNotifierForTeammates(
          notifier,
          (worktreeId) =>
            activeCallMayTouchHostTabs(worktreeId, () => this.store?.getBots?.() ?? []),
          hostWindowLookups(this.mobileSessionTabsByWorktree)
        )
      : null
    if (notifier) {
      this.repositoryForkBackfill.start()
      queueMicrotask(() => this.retrySleptMailboxWakes())
    }
  }

  protected countTerminalSideEffectConsumingClientEventListeners(): number {
    return this.clientEvents.countTerminalSideEffectConsumers()
  }
}

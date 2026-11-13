import type {
  PointerDeliveryDependencies,
  PointerDeliveryOptions
} from './mailbox-pointer-delivery-contract'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxPointerDelivery } from './mailbox-pointer-delivery'
import { isMailboxTerminalTakingInput } from '../routing/mailbox-owner'
import type { OrchestrationMailboxPointerSubmitTarget } from './mailbox-pointer-submit'

type ForegroundMailboxBatch = Map<string, ReadonlySet<string> | undefined>

/** Every mailbox behind a terminal's probe re-enters normal admission with the same fresh evidence. */
export class MailboxForegroundDelivery {
  private readonly mailboxesByPty = new Map<string, ForegroundMailboxBatch>()

  defer<T extends OrchestrationMessageWaiter>(
    deps: PointerDeliveryDependencies<T>,
    delivery: OrchestrationMailboxPointerDelivery<T>,
    ptyId: string,
    options: PointerDeliveryOptions,
    target: OrchestrationMailboxPointerSubmitTarget
  ): boolean {
    if (options.foregroundProbeIncarnation === target.processIncarnation) {
      return false
    }
    const mailboxHandle = options.mailboxHandle
    const deferred = this.mailboxesByPty.get(ptyId)
    if (deferred) {
      deferred.set(mailboxHandle, options.reservedTypes)
      return true
    }
    const mailboxes = new Map([[mailboxHandle, options.reservedTypes]])
    this.mailboxesByPty.set(ptyId, mailboxes)
    void delivery
      .probeForeground(ptyId, target.processIncarnation)
      .then((foreground) => {
        this.mailboxesByPty.delete(ptyId)
        const requireCurrentScreen =
          delivery.isForegroundHeld(ptyId) || deps.getTerminal(ptyId)?.lastAgentStatus === null
        const current = deps.resolveSubmitTarget(ptyId, foreground.foreground)
        if (current?.processIncarnation !== target.processIncarnation) {
          return
        }
        const applied = delivery.applyForeground(
          ptyId,
          foreground,
          foreground.foreground,
          foreground.foreground === 'agent' &&
            isMailboxTerminalTakingInput(current.terminal) &&
            deps.isAgentSettledForDelivery(ptyId, foreground.foreground)
        )
        if (applied && delivery.isForegroundHeld(ptyId)) {
          return
        }
        if (!applied && options.foregroundFollowup) {
          deps.onDeliveryDecision(ptyId, { foreground: true })
          return
        }
        for (const [probedMailbox, reservedTypes] of mailboxes) {
          const terminal = deps.getTerminal(ptyId)
          if (terminal) {
            delivery.deliver(terminal, {
              mailboxHandle: probedMailbox,
              reservedTypes,
              foreground: applied ? foreground.foreground : undefined,
              foregroundFollowup: true,
              requireCurrentScreen,
              skipAbsenceProbe: true,
              foregroundProbeIncarnation: applied ? target.processIncarnation : undefined
            })
          }
        }
      })
      .catch(() => undefined)
      .finally(() => deps.onDeliveryDecision(ptyId))
    return true
  }
}

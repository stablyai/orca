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

  deliverForHandle<T extends OrchestrationMessageWaiter>(
    deps: PointerDeliveryDependencies<T>,
    delivery: OrchestrationMailboxPointerDelivery<T>,
    handle: string,
    reservedTypes?: ReadonlySet<string>
  ): void {
    try {
      const terminal = deps.deliveryTarget.resolveTerminal(handle)
      if (
        !terminal ||
        (!isMailboxTerminalTakingInput(terminal) &&
          !(
            delivery.isForegroundHeld(terminal.ptyId) ||
            deps.needsForegroundEvaluation?.(terminal.ptyId)
          ) &&
          !deps.isForegroundCandidate?.(terminal))
      ) {
        if (terminal) {
          deps.onDeliveryDecision(terminal.ptyId)
        }
        return
      }
      const mailboxHandle = deps.mailboxOwner.resolve(terminal, handle)
      if (mailboxHandle) {
        delivery.deliver(terminal, { mailboxHandle, reservedTypes })
      }
    } catch {
      // Persisted mail remains available to explicit check or the terminal's next input edge.
    }
  }

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
        const current = deps.resolveSubmitTarget(
          ptyId,
          foreground.foreground,
          undefined,
          foreground.agent
        )
        if (
          current?.processIncarnation !== target.processIncarnation ||
          current.terminal.handle !== target.terminal.handle
        ) {
          return
        }
        const applied = delivery.applyForeground(
          ptyId,
          foreground,
          foreground.foreground,
          foreground.foreground === 'agent' &&
            isMailboxTerminalTakingInput(current.terminal) &&
            deps.isAgentSettledForDelivery(
              ptyId,
              foreground.foreground,
              undefined,
              foreground.agent
            )
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
              agent: applied ? foreground.agent : undefined,
              foregroundFollowup: true,
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

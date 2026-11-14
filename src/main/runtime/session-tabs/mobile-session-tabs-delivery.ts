import type { RuntimeAgentSenderAssociations } from '../agent-senders/runtime-agent-sender-associations'
import type { MobileSessionTabSubscription } from '../construction/runtime-identity-state'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'

type DeliveryArgs = [
  result: RuntimeMobileSessionTabsResult,
  changeSequence: number,
  clientNavigationId?: string,
  candidates?: readonly MobileSessionTabSubscription[],
  delivery?: 'reconciliation'
]
type SenderPass = ReturnType<RuntimeAgentSenderAssociations['buildForFramePass']>

type DeliveryHost = {
  senders: RuntimeAgentSenderAssociations
  listeners: (
    worktree: string,
    navigation?: string,
    candidates?: readonly MobileSessionTabSubscription[]
  ) => MobileSessionTabSubscription[]
  subscribed: (subscription: MobileSessionTabSubscription) => boolean
  project: (
    frame: RuntimeMobileSessionTabsResult,
    navigation?: string
  ) => RuntimeMobileSessionTabsResult
  deliver: (
    subscription: MobileSessionTabSubscription,
    frame: RuntimeMobileSessionTabsResult,
    sequence: number,
    delivery?: 'reconciliation'
  ) => void
  source: (worktree: string) => unknown
  epoch: () => number | null
  releaseHistory: () => void
}

/** One prepared sender walk serves every frame in a publication pass. */
export function createMobileSessionTabsDelivery(
  host: DeliveryHost
): (...args: DeliveryArgs) => Promise<void> {
  const pending: {
    args: DeliveryArgs
    source: unknown
    epoch: number | null
    complete: () => void
  }[] = []
  let scheduled = false
  const deliverNow = (args: DeliveryArgs, senderScope: () => SenderPass): void => {
    const [result, sequence, navigation, candidates, delivery] = args
    const { agentSenderAssociations: _senders, ...tabsOnly } = result
    let desktopFrame: RuntimeMobileSessionTabsResult | undefined
    for (const subscription of host.listeners(result.worktree, navigation, candidates)) {
      if (!host.subscribed(subscription)) {
        continue
      }
      let frame = tabsOnly
      if (subscription.clientKind !== 'mobile') {
        desktopFrame ??= {
          ...result,
          agentSenderAssociations: senderScope()(result.worktree)
        }
        frame = desktopFrame
      }
      const supplied =
        navigation === undefined ? host.project(frame, subscription.clientNavigationId) : frame
      host.deliver(subscription, supplied, sequence, delivery)
    }
    const senders = desktopFrame?.agentSenderAssociations
    if (navigation === undefined && senders) {
      host.senders.acknowledgeFrame(result.worktree, senders)
    }
  }
  const schedule = (): void => {
    if (scheduled) {
      return
    }
    scheduled = true
    queueMicrotask(() => {
      const batch = pending.splice(0)
      void host.senders
        .withPreparedPublication(() => {
          let senderScope: SenderPass | undefined
          try {
            for (const { args, source, epoch } of batch) {
              if (host.source(args[0].worktree) !== source || host.epoch() !== epoch) {
                continue
              }
              deliverNow(args, () => (senderScope ??= host.senders.buildForFramePass()))
            }
          } finally {
            if (senderScope) {
              host.releaseHistory()
            }
          }
        })
        .catch((error: unknown) => console.warn('[runtime] Sender frame publication failed', error))
        .finally(() => {
          batch.forEach(({ complete }) => complete())
          scheduled = false
          if (pending.length) {
            schedule()
          }
        })
    })
  }
  return (...args): Promise<void> => {
    const [result, , navigation, candidates] = args
    if (
      !host
        .listeners(result.worktree, navigation, candidates)
        .some((subscription) => subscription.clientKind !== 'mobile')
    ) {
      deliverNow(args, () => {
        throw new Error('Mobile frames do not contain sender associations')
      })
      return Promise.resolve()
    }
    const delivered = new Promise<void>((complete) => {
      pending.push({ args, source: host.source(result.worktree), epoch: host.epoch(), complete })
    })
    schedule()
    return delivered
  }
}

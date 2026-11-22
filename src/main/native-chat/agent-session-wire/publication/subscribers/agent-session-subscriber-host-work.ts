import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import type { Subscriber } from './agent-session-subscribe-input'

type BatchEvent = Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
/** Host facts a row-carrying batch must restate, or the client clears them. */
export type SubscriberHostWork = Pick<BatchEvent, 'latestTurn' | 'working' | 'actionablePromptIds'>
/** What the client holds for the host facts after this frame, by the reducer's restatement rule. */
export function rememberSubscriberHostWork(
  subscriber: Subscriber,
  event: AgentSessionSubscribeEvent
): void {
  if (event.type === 'snapshot' || event.type === 'reset') {
    const { latestTurn, working, actionablePromptIds } = event.page
    subscriber.hostWork = { latestTurn, working, actionablePromptIds }
    return
  }
  if (event.type !== 'batch') {
    return
  }
  const { items, removedItemIds, submissions } = event.batch
  const restates = items.length > 0 || removedItemIds.length > 0 || submissions.length > 0
  const prior = subscriber.hostWork ?? {}
  const field = <K extends keyof SubscriberHostWork>(key: K): SubscriberHostWork[K] =>
    restates || event[key] !== undefined ? event[key] : prior[key]
  subscriber.hostWork = {
    latestTurn: field('latestTurn'),
    working: field('working'),
    actionablePromptIds: field('actionablePromptIds')
  }
}

export function hostWorkFields(subscriber: Subscriber): Partial<SubscriberHostWork> {
  const work = subscriber.hostWork ?? {}
  return Object.fromEntries(Object.entries(work).filter(([, value]) => value !== undefined))
}

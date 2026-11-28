import type { MobileBotRowFacts } from './host-bot-row-facts'

/** Whether a bot row's long-press offers Pin: its host takes one, the host is up, and the list is writable. */
export function botPinOffered(
  facts: Pick<MobileBotRowFacts, 'host' | 'takesPin'>,
  readOnly: boolean
): boolean {
  return !readOnly && facts.host?.word === undefined && facts.takesPin === true
}

// A tool tick is the owner's yes to one address in one link. Tool ids are positional (t1, t2…), so a
// later version of the link can give an old id another address: reading the link again keeps a tick
// only where the same link still has the same tool at the same address.
import type { PhoneShareReview } from './bot-share-receive-operations'

type ToolsOf = Pick<PhoneShareReview, 'shareId'> & { bot: Pick<PhoneShareReview['bot'], 'tools'> }

/** The ticks that still hold on `next`, given they were made on `shown`; none for another link. */
export function keptToolTicks(
  shown: ToolsOf | null,
  next: ToolsOf,
  ticked: readonly string[]
): string[] {
  if (!shown || shown.shareId !== next.shareId) {
    return []
  }
  return ticked.filter((id) => {
    const before = shown.bot.tools.find((tool) => tool.id === id)
    const after = next.bot.tools.find((tool) => tool.id === id)
    return (
      before !== undefined &&
      after !== undefined &&
      before.name === after.name &&
      before.url === after.url
    )
  })
}

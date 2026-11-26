// A tool tick is the owner's yes to one tool in one link. Tool ids are positional (t1, t2…), so a
// later version of the link can give an old id another tool: reading the link again keeps a tick
// only where the same link still has the same tool, every field but the id unchanged.
import type { PhoneShareReview } from './bot-share-receive-operations'

type ToolsOf = Pick<PhoneShareReview, 'shareId'> & { bot: Pick<PhoneShareReview['bot'], 'tools'> }
type Tool = ToolsOf['bot']['tools'][number]

// Every field the computer sent (name, url, header names, and any added later), key order aside.
function toolFacts(tool: Tool): string {
  const { id: _id, ...rest } = tool
  return JSON.stringify(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

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
    return before !== undefined && after !== undefined && toolFacts(before) === toolFacts(after)
  })
}

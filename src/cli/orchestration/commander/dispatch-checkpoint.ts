import type { CommanderMemoryRevision } from '../../../shared/commander/memory-contract'
import { clampUtf8TextPrefix } from '../../../shared/text/utf8-byte-limits'

export function dispatchCheckpoint(
  pages: CommanderMemoryRevision[],
  projectId: string,
  budget: number
) {
  const page = pages
    .filter(
      (p) =>
        !p.deleted &&
        p.kind === 'note' &&
        p.projectId === projectId &&
        p.body.trim() &&
        p.actor.type === 'commander' &&
        p.actor.id === 'orca-checkpoint' &&
        /^checkpoint-[a-f0-9]{64}$/.test(p.pageId) &&
        Number.isFinite(Date.parse(p.createdAt))
    )
    .toSorted(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.pageId.localeCompare(b.pageId)
    )[0]
  if (!page) {
    return undefined
  }
  const heading = `Recorded project progress at ${page.createdAt} (observation; verify against the checkout):\n`
  const remaining = Math.min(2048, budget) - Buffer.byteLength(heading)
  if (remaining < 40) {
    return { page, excerpt: '' }
  }
  const quote = page.body
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  const preview =
    Buffer.byteLength(quote) <= remaining ? quote : `${clampUtf8TextPrefix(quote, remaining - 3)}…`
  return { page, excerpt: heading + preview }
}

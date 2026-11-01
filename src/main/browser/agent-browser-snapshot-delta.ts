import type { BrowserActionEffects } from '../../shared/runtime-browser-contracts'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'

// Results travel to remote clients with a 768 KB budget; agents read them in their context.
const PAGE_CHARS = 6_000
const LINE_CHARS = 200

type PageChange = Exclude<BrowserActionEffects['page'], undefined>

/** agent-browser 0.39's `snapshot --delta` reply as the lines that changed, within PAGE_CHARS. */
export function readPageChange(reply: unknown): PageChange | undefined {
  const snapshot = isRecord(reply) ? reply.snapshot : undefined
  if (!isRecord(snapshot)) {
    return undefined
  }
  if (snapshot.kind === 'unchanged') {
    return 'unchanged'
  }
  if (snapshot.kind === 'full' && typeof snapshot.tree === 'string') {
    return budgetLines(snapshot.tree.split('\n'), 0, true)
  }
  const change = snapshot.treeChange
  if (snapshot.kind === 'delta' && isRecord(change) && Array.isArray(change.lines)) {
    const lines = change.lines.filter((line): line is string => typeof line === 'string')
    const removed = typeof change.deleteCount === 'number' ? change.deleteCount : 0
    return budgetLines(lines, removed, false)
  }
  return undefined
}

function budgetLines(
  lines: string[],
  removedLines: number,
  full: boolean
): Exclude<PageChange, 'unchanged'> {
  const kept: string[] = []
  let chars = 0
  let clipped = false
  for (const line of lines) {
    const keptLine = clipLine(line)
    if (chars + keptLine.length > PAGE_CHARS) {
      break
    }
    clipped ||= keptLine !== line
    kept.push(keptLine)
    chars += keptLine.length + 1
  }
  return { lines: kept, removedLines, full, truncated: clipped || kept.length < lines.length }
}

// A long accessible name must not cost the agent the element's ref.
function clipLine(line: string): string {
  if (line.length <= LINE_CHARS) {
    return line
  }
  const head = line.slice(0, LINE_CHARS)
  const ref = /\bref=e\d+/.exec(line)?.[0]
  return ref && !head.includes(ref) ? `${head}… [${ref}]` : `${head}…`
}

import { normalizeQuickOpenRgLine } from '../shared/quick-open-filter'
import type { FileInventoryBudget } from '../shared/file-inventory-budget'
import type { QuickOpenPathRanker } from '../shared/quick-open-path-search'

export function retainRelayFileListingPath(
  rawLine: string,
  ranker: QuickOpenPathRanker | null,
  retention: {
    files: Set<string>
    budget: FileInventoryBudget | null
    includePath: (path: string) => boolean
  }
): boolean {
  const { files, budget, includePath } = retention
  const relativePath = normalizeQuickOpenRgLine(rawLine, { kind: 'cwd-relative' })
  if (relativePath === null) {
    return false
  }
  if (!includePath(relativePath)) {
    return true
  }
  if (ranker) {
    ranker.consider(relativePath)
  } else if (!files.has(relativePath)) {
    budget?.record(relativePath)
    files.add(relativePath)
  }
  return true
}

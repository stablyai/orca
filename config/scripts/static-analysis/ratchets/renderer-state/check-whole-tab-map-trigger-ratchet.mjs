import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'
import { stripCommentsAndQuotedStrings } from './check-workspace-record-read-ratchet.mjs'

// Every tab write replaces these maps (terminal title batches included); a whole-map identity check reruns its work for all of them.
// Lower bound: misses destructured or aliased comparisons. Compare a derived per-workspace answer instead.

const BASELINE_PATH = 'config/whole-tab-map-trigger-baseline.txt'
const SCAN_ROOTS = ['src/renderer/src/']
// `state.tabsByWorktree !== previous.tabsByWorktree`, `prev?.unifiedTabsByWorktree === next.unifiedTabsByWorktree`.
const WHOLE_MAP_COMPARISON =
  /\.(unifiedTabsByWorktree|tabsByWorktree)\s*[!=]==?\s*[\w$]+(?:\?\.|\.)\1\b/g

export function isScannedFile(rel) {
  return (
    /\.tsx?$/.test(rel) &&
    !rel.endsWith('.d.ts') &&
    !/\.(?:test|spec)\.tsx?$|fixture|test-harness|test-support|\/testing\//.test(rel)
  )
}

export function countWholeTabMapTriggers(text) {
  return [...stripCommentsAndQuotedStrings(text).matchAll(WHOLE_MAP_COMPARISON)].length
}

export function collectWholeTabMapTriggers(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, text] of readTrackedSources(root, SCAN_ROOTS, isScannedFile)) {
    const count = countWholeTabMapTriggers(text)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'whole-tab-map-trigger',
      baselinePath: BASELINE_PATH,
      unit: 'whole tab-map identity comparison(s)',
      header: [
        '# Renderer identity comparisons of the whole `unifiedTabsByWorktree` / `tabsByWorktree` map,',
        '# as `<count> <file>`. Every tab write anywhere replaces these maps, so work gated on them reruns',
        '# for unrelated workspaces. This is a RATCHET: counts may only go DOWN.',
        '# Prune after a fix: pnpm check:whole-tab-map-trigger-ratchet --prune'
      ],
      collect: collectWholeTabMapTriggers,
      fix: [
        'Gate the work on a derived answer that keeps its identity across unrelated tab writes:',
        '  getStructuredAgentSessionTabs in components/native-chat/session/status/structured-agent-session-tabs.ts',
        '                                              (chat tabs, rebuilt per changed workspace bucket)',
        '  or compare the one workspace bucket the work reads.'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}

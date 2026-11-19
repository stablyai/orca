import { realpath } from 'node:fs/promises'
import { withTimeoutResult } from '../../../shared/concurrency/promise-timeout-fallback'
import type { SkillScanRoot } from './skill-discovery-sources'

// A home on an unresponsive mount must not hold up every other root; unanswered pairs stay apart.
const SAME_FOLDER_CHECK_TIMEOUT_MS = 1_000

/** A relocated home that links back to the default one (a managed Claude account's `skills`) is
 *  one folder: scan it once, for the owner and the agents that borrow it. */
export async function withoutLinkedDefaultHomes(
  roots: readonly SkillScanRoot[]
): Promise<SkillScanRoot[]> {
  const defaults = roots.filter((root) => root.readers === 'borrowers')
  if (defaults.length === 0) {
    return [...roots]
  }
  const real = (path: string) => realpath(path).catch(() => path)
  const linked = new Set<SkillScanRoot>()
  await Promise.all(
    defaults.map(async (fallback) => {
      const relocated = roots.find(
        (root) => root.readers === 'owner' && root.owner === fallback.owner
      )
      if (!relocated) {
        return
      }
      const paths = await withTimeoutResult(
        Promise.all([real(relocated.path), real(fallback.path)]),
        SAME_FOLDER_CHECK_TIMEOUT_MS
      )
      if (paths.ok && paths.value[0] === paths.value[1]) {
        linked.add(fallback).add(relocated)
      }
    })
  )
  return roots.flatMap((root) => {
    if (!linked.has(root)) {
      return [root]
    }
    if (root.readers === 'borrowers') {
      return []
    }
    const { readers: _readers, ...shared } = root
    return [shared]
  })
}

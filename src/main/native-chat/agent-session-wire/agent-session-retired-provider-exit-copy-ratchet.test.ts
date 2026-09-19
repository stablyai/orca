import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSourceTree, stripComments } from '../../../shared/source-scan/source-tree-scan'

/**
 * The retired copy has to stay retired.
 *
 * A bare `Provider exited: <reason>` status row is the reported symptom: a chat the user could
 * not act on, settled by a restart rather than by observed death. Both production writers of that
 * copy are gone, replaced by outcome copy the death evidence decides. Nothing filters this string
 * at read time, so a producer that resurrects it reaches the transcript directly — which is why
 * the guard sits on the writing side.
 *
 * Deliberately narrow: only a literal that OPENS with the prefix. Prose about the retirement, and
 * copy that merely mentions a provider exiting, are not producers.
 */

const RETIRED_COPY_PREFIX = 'Provider exited'

/** Line numbers of string literals whose first character begins the retired copy. */
export function findRetiredProviderExitCopyLines(source: string): number[] {
  const code = stripComments(source)
  const pattern = new RegExp(`['"\`]${RETIRED_COPY_PREFIX}`, 'g')
  return [...code.matchAll(pattern)].map((match) => code.slice(0, match.index).split('\n').length)
}

describe('retired provider-exit copy ratchet', () => {
  it('flags a literal that opens with the retired copy', () => {
    const flagged = [
      `const text = 'Provider exited: recorded pid absent on host'`,
      `appendStatus("Provider exited")`,
      'appendStatus(`Provider exited: ${reason}`)'
    ]
    for (const source of flagged) {
      expect(findRetiredProviderExitCopyLines(source), source).toHaveLength(1)
    }
  })

  it('reports the line the literal sits on', () => {
    expect(findRetiredProviderExitCopyLines(`const a = 1\n\nconst b = 'Provider exited'`)).toEqual([
      3
    ])
  })

  it('leaves prose and unrelated copy alone', () => {
    const allowed = [
      `// the old bare 'Provider exited: <reason>' row`,
      `/* wrote \`Provider exited\` once */`,
      `const text = 'provider exited'`,
      `const text = 'The provider exited unexpectedly'`,
      `const text = 'Provider exit was not proven'`,
      `if (text.startsWith(prefix)) {}`
    ]
    for (const source of allowed) {
      expect(findRetiredProviderExitCopyLines(source), source).toEqual([])
    }
  })

  const repoRoot = resolve(__dirname, '..', '..', '..', '..')
  // Tests assert on the retired copy on purpose; the walk skips them.
  const files = scanSourceTree(join(repoRoot, 'src'))

  it('scans a plausible number of files', () => {
    // A broken root or extension list would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(500)
  })

  it('has no production writer of the retired copy', () => {
    const offenders = files.flatMap(({ relativePath, source }) =>
      findRetiredProviderExitCopyLines(source).map((line) => `src/${relativePath}:${line}`)
    )
    expect(
      offenders,
      `A status row whose copy opens with "${RETIRED_COPY_PREFIX}" lands in the user's transcript ` +
        'unfiltered, which is the symptom this chat surface was reported for. Write the outcome ' +
        'copy the death evidence decides instead of resurrecting the retired prefix.'
    ).toEqual([])
  })
})

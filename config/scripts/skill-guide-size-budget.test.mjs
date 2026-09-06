import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const guideRoot = resolve(import.meta.dirname, '../../skill-guides')

/**
 * Provenance: the Agent Skills spec's "keep your main SKILL.md under 500 lines" is an explicit
 * recommendation, not a limit, and nothing rejects a longer guide. 300 is the tighter bound this
 * repo already practices — six of eight guides sit under it, and `orchestration.md` is being cut to a ~200-line kernel in #16904
 * by routing detail into `references/`, which is the restructure this budget is meant to push.
 * A line count is not a token count; treat a green run as a shape check, not a context-budget proof.
 */
const MAX_GUIDE_LINES = 300

/**
 * Guides that already exceed the bound, with the size they may not grow past. Recorded sizes are a
 * ratchet ceiling, not a target: shrink them freely and delete the entry once the guide fits.
 * A name may leave this set. A name may never join it — split the guide into `references/` instead.
 */
const OVER_BUDGET = new Map([['orca-per-workspace-env', 397]])

/** Matches `wc -l`: a trailing newline ends the last line rather than starting a new one. */
function lineCount(contents) {
  const lines = contents.split(/\r?\n/u)
  return lines.at(-1) === '' ? lines.length - 1 : lines.length
}

function guideSizes() {
  return new Map(
    readdirSync(guideRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => [
        entry.name.replace(/\.md$/u, ''),
        lineCount(readFileSync(join(guideRoot, entry.name), 'utf8'))
      ])
  )
}

describe('always-loaded skill guide size budget', () => {
  const sizes = guideSizes()

  it('measures every shipped guide', () => {
    expect(sizes.size).toBeGreaterThanOrEqual(8)
    expect(sizes.get('orchestration')).toBeGreaterThan(0)
  })

  it('keeps every guide outside OVER_BUDGET under the bound', () => {
    const violations = [...sizes]
      .filter(([name, size]) => size > MAX_GUIDE_LINES && !OVER_BUDGET.has(name))
      .map(([name, size]) => `${name}: ${size} lines > ${MAX_GUIDE_LINES}`)

    expect(violations).toEqual([])
  })

  it('never lets an OVER_BUDGET guide grow past its recorded size', () => {
    const grown = [...OVER_BUDGET]
      .filter(([name, ceiling]) => (sizes.get(name) ?? 0) > ceiling)
      .map(([name, ceiling]) => `${name}: ${sizes.get(name)} lines > recorded ${ceiling}`)

    expect(grown).toEqual([])
  })

  it('drops OVER_BUDGET entries that now fit, so the set only ratchets down', () => {
    const stale = [...OVER_BUDGET.keys()].filter(
      (name) => !sizes.has(name) || (sizes.get(name) ?? 0) <= MAX_GUIDE_LINES
    )

    expect(stale).toEqual([])
  })
})

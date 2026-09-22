import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Why `RightDrawer`'s `useAnimatedScrollHandler` having no dependency array is not a defect.
 *
 * C1.10 pinned four Reanimated hooks to carrying one, because on the web each starts a mapper whose
 * inputs are read from that array: a shared value the updater reads and the array omits is a mapper
 * that never re-runs. `useAnimatedScrollHandler` is deliberately not one of those four, and the
 * review page is the first to put a `RightDrawer` inside the shell, so the question was carried into
 * C4 as a risk rather than a known break (design-ota-c4.md §4).
 *
 * Two static facts answer it, and this file is where they are recorded rather than remembered:
 *
 * 1. The hook is an event handler, not a mapper. It is absent from `MAPPER_HOOKS` in
 *    `reanimated-web-mapper-deps.test.ts` on purpose, and the four that are there are the four that
 *    start a mapper.
 * 2. Its updater's only effect is a write. `scrollOffsetY` is assigned in `RightDrawer.tsx` and read
 *    nowhere in it, so there is no consumer for a stale value to reach.
 *
 * Together those say the missing array has no observable consequence in this drawer. Asserted
 * rather than written in a comment, because both halves are facts about source that someone will
 * change: a later read of `scrollOffsetY` reds case 2 the moment it is added.
 */

const COMPONENTS = import.meta.dirname
const DRAWER = 'RightDrawer.tsx'
const MAPPER_CENSUS = join(COMPONENTS, '..', 'reanimated-web-mapper-deps.test.ts')
const SHARED_VALUE = 'scrollOffsetY'

const drawerSource = readFileSync(join(COMPONENTS, DRAWER), 'utf8')

describe('the drawer scroll handler and its dependency array', () => {
  it('is the hook the mapper census does not rule, and the census still rules four', () => {
    const census = readFileSync(MAPPER_CENSUS, 'utf8')
    const ruled = [...census.matchAll(/^ {2}\['(use[A-Za-z]+)',/gm)].map((match) => match[1])
    expect(ruled.sort()).toEqual([
      'useAnimatedProps',
      'useAnimatedReaction',
      'useAnimatedStyle',
      'useDerivedValue'
    ])
    expect(ruled).not.toContain('useAnimatedScrollHandler')
    // The precondition: the drawer really does call it, so the two cases are about this file.
    expect(drawerSource).toContain('useAnimatedScrollHandler(')
  })

  it('writes the shared value its updater touches and reads it nowhere', () => {
    const uses = [...drawerSource.matchAll(new RegExp(`${SHARED_VALUE}\\b[^\\n]*`, 'g'))].map(
      (match) => match[0]
    )
    // Three: the declaration, the reset on close, and the updater's assignment.
    expect(uses).toHaveLength(3)
    expect(uses[0]).toContain('useSharedValue(')
    // A read is `scrollOffsetY.value` anywhere other than the left of an assignment. Both
    // non-declaration uses are assignments, so there is none.
    const reads = uses
      .slice(1)
      .filter((use) => !new RegExp(`${SHARED_VALUE}\\.value\\s*=[^=]`).test(use))
    expect(reads).toEqual([])
  })
})

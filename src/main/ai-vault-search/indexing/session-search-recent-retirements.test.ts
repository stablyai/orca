import { expect, it } from 'vitest'
import { SessionSearchRecentRetirements } from './session-search-recent-retirements'

it.each([
  { population: 40, expected: ['39', '38', '37'] },
  { population: 400, expected: ['399', '398', '397'] }
])(
  'selects the newest paths from $population entries arriving oldest first',
  ({ population, expected }) => {
    const selection = new SessionSearchRecentRetirements(3)
    for (let index = 0; index < population; index++) {
      selection.add({ path: String(index), mtimeMs: index })
    }
    expect(selection.paths()).toEqual(expected)
  }
)

it('keeps earlier observed paths on equal timestamps at the selection boundary', () => {
  const selection = new SessionSearchRecentRetirements(3)
  for (const [path, mtimeMs] of [
    ['z', 20],
    ['a', 10],
    ['b', 10],
    ['c', 10],
    ['old', 0]
  ] as const) {
    selection.add({ path, mtimeMs })
  }
  expect(selection.paths()).toEqual(['z', 'a', 'b'])
})

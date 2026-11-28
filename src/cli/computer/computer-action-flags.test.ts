import { describe, expect, it } from 'vitest'
import { getComputerActionObserveFlags } from './computer-action-flags'

function observe(
  entries: [string, string | boolean][]
): ReturnType<typeof getComputerActionObserveFlags> {
  return getComputerActionObserveFlags(new Map(entries))
}

describe('getComputerActionObserveFlags screenshots', () => {
  it('skips the screenshot unless --screenshot or a size flag asks for one', () => {
    expect(observe([]).noScreenshot).toBe(true)
    expect(observe([['screenshot', true]]).noScreenshot).toBeUndefined()
    expect(observe([['screenshot-scale', '1']])).toMatchObject({
      screenshotScale: 1,
      noScreenshot: undefined
    })
  })

  it('refuses --screenshot together with --no-screenshot', () => {
    expect(() =>
      observe([
        ['screenshot', true],
        ['no-screenshot', true]
      ])
    ).toThrow(expect.objectContaining({ code: 'invalid_argument' }))
  })
})

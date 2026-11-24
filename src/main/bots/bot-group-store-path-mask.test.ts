import { describe, expect, it } from 'vitest'
import { maskStorePaths } from './bot-group-store-path-mask'

const ID = '0b5c6f0e-8e8e-4f0e-9a9a-0123456789ab'
const STORE = `agent-session-attachments/${ID}`
const mask = (words: string) => maskStorePaths(words, '[image]')

describe('masking attachment-store paths', () => {
  it('masks the whole path from its root, spaces in folder names included', () => {
    expect(mask(`Saved /Users/Alice Smith/.orca/${STORE}/shot.png ok`)).toBe('Saved [image] ok')
    expect(mask(`Saved /Users/a/.orca/${STORE}/shot.png`)).toBe('Saved [image]')
    expect(mask(`see ~/My Files/${STORE}/a.png`)).toBe('see [image]')
    expect(mask(`(~/.orca/${STORE}/a.png)`)).toBe('[image]')
    expect(
      mask(`see src/x and C:\\Users\\Al B\\AppData\\agent-session-attachments\\${ID}\\a.png done`)
    ).toBe('see src/x and [image] done')
  })

  it('masks a path written without its root from its first character', () => {
    expect(mask(`rel .orca/${STORE}/a.png end`)).toBe('rel [image] end')
    expect(mask(`${STORE}/a.png`)).toBe('[image]')
  })

  it('masks each of several paths on one line, and leaves other words alone', () => {
    expect(mask(`two /Users/A B/${STORE}/a.png and /Users/C D/${STORE}/b.png`)).toBe(
      'two [image] and [image]'
    )
    expect(mask('"/Users/A B/x" and nothing else')).toBe('"/Users/A B/x" and nothing else')
  })

  it('stops at a quote or a new line', () => {
    expect(mask(`"/Users/A B" then /tmp/${STORE}/a.png`)).toBe('"/Users/A B" then [image]')
    expect(mask(`/Users/A B\nsee /x/${STORE}/a.png`)).toBe('/Users/A B\nsee [image]')
  })

  it('reads a very long unbroken run once, not once per character', () => {
    // A quadratic scan of a million characters would run far past the test's time limit.
    const run = 'x'.repeat(1_000_000)
    expect(mask(run)).toBe(run)
    expect(mask(`${run}/${STORE}/a.png`)).toBe('[image]')
    expect(mask(`/a ${'b/'.repeat(200_000)}`)).toBe(`/a ${'b/'.repeat(200_000)}`)
  })
})

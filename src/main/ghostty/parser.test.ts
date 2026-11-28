import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseGhosttyConfig } from './parser'
import { resolveGhosttyThemeColors } from './theme-resolution'

it('imports a theme whose unquoted filename contains a literal hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-ghostty-literal-hash-'))
  try {
    const theme = join(directory, 'Dark # Blue')
    await writeFile(theme, 'background = #123abc\nforeground = #abcdef\n')
    const parsed = parseGhosttyConfig(`# whole-line comment\ntheme = ${theme}\nfont-size = 14\n`)
    expect(parsed['font-size']).toBe('14')
    expect(await resolveGhosttyThemeColors(String(parsed.theme))).toEqual({
      background: '#123abc',
      foreground: '#abcdef'
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

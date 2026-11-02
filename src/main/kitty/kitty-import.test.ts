import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mapKittyToOrca } from './mapper'
import { loadKittyConfig } from './parser'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'orca-kitty-import-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('Kitty config import', () => {
  it('follows include, globinclude and continuation lines without running geninclude', async () => {
    await mkdir(path.join(dir, 'themes'))
    await writeFile(
      path.join(dir, 'kitty.conf'),
      [
        '# comment',
        'font_family      family="JetBrains Mono" style=Regular',
        'font_size 13',
        'include current-theme.conf',
        'globinclude themes/*.conf',
        'geninclude make-colors.py',
        'map ctrl+c copy_to_clipboard',
        'window_padding_width 4',
        '\\ 8',
        'include kitty.conf'
      ].join('\n')
    )
    await writeFile(
      path.join(dir, 'current-theme.conf'),
      'background #1e1e2e\nforeground #cdd6f4\ncolor1 #f38ba8\ncursor_shape beam\n'
    )
    await writeFile(
      path.join(dir, 'themes', 'override.conf'),
      'color1 #ff0000\nbackground_opacity 0.9\n'
    )

    const { config, readPaths } = await loadKittyConfig(path.join(dir, 'kitty.conf'), dir)
    const { diff, unsupportedKeys } = mapKittyToOrca(config, true)

    expect(readPaths).toEqual([
      path.join(dir, 'kitty.conf'),
      path.join(dir, 'current-theme.conf'),
      path.join(dir, 'themes', 'override.conf')
    ])
    expect(diff).toEqual({
      terminalFontFamily: 'JetBrains Mono',
      terminalFontSize: 13,
      terminalCursorStyle: 'bar',
      terminalBackgroundOpacity: 0.9,
      terminalPaddingX: 8,
      terminalPaddingY: 4,
      terminalColorOverrides: { background: '#1e1e2e', foreground: '#cdd6f4', red: '#ff0000' }
    })
    expect(unsupportedKeys).toEqual(['geninclude', 'map'])
  })

  it('reports values Orca cannot represent instead of guessing', () => {
    const options = new Map([
      ['font_family', 'monospace'],
      ['cursor_text_color', 'background'],
      ['cursor_shape', 'hollow'],
      ['macos_option_as_alt', 'left'],
      ['constructor', '#ff0000']
    ])
    const { diff, unsupportedKeys } = mapKittyToOrca({ options, unsupportedKeys: [] }, false)
    expect(diff).toEqual({})
    expect(unsupportedKeys).toEqual([
      'font_family',
      'cursor_text_color',
      'cursor_shape',
      'macos_option_as_alt',
      'constructor'
    ])
  })
})

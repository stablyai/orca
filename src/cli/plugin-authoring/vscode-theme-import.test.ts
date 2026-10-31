import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compactTokenColors, renderVscodeThemePlugin } from './vscode-theme-conversion'
import { readVscodeThemes, VscodeThemeReadError } from './vscode-theme-reading'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-vscode-theme-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text)
  }
  return dir
}

const identity = { publisher: 'acme', id: 'night', name: 'Night' }

describe('VS Code theme import', () => {
  it('flattens includes, maps workbench colors and emits a terminal palette', () => {
    const dir = folder({
      'package.json': JSON.stringify({
        displayName: 'Night',
        contributes: { themes: [{ label: 'Night', uiTheme: 'vs-dark', path: './night.json' }] }
      }),
      // JSONC: comments and trailing commas, as VS Code allows.
      'base.json': `{
        // shared colors
        "colors": { "editor.background": "#101010", "button.background": "#ff000080", },
        "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#888888" } }],
      }`,
      'night.json': JSON.stringify({
        include: './base.json',
        colors: {
          'editor.foreground': '#eeeeee',
          'panel.border': '#ffffff20',
          'terminal.ansiRed': '#ff5555',
          'terminal.selectionBackground': '#ffffff40'
        },
        tokenColors: [{ scope: 'comment', settings: { fontStyle: 'italic' } }],
        semanticTokenColors: { variable: '#ffffff' }
      })
    })
    const set = readVscodeThemes(dir)
    expect(set.name).toBe('Night')
    expect(set.warnings).toEqual([expect.stringContaining('semanticTokenColors')])
    const plugin = renderVscodeThemePlugin(set, identity)
    const app = JSON.parse(plugin.files['themes/night.json'])
    expect(app).toMatchObject({
      base: 'dark',
      tokens: {
        '--background': '#101010',
        '--foreground': '#eeeeee',
        // Translucent fills are painted onto the editor background; borders keep their alpha.
        '--primary': '#880808',
        '--border': '#ffffff20'
      },
      tokenColors: [{ scope: 'comment', settings: { foreground: '#888888', fontStyle: 'italic' } }]
    })
    expect(JSON.parse(plugin.files['terminal/night.json']).terminal).toMatchObject({
      background: '#101010',
      foreground: '#eeeeee',
      red: '#ff5555',
      selectionBackground: '#4c4c4c'
    })
    expect(JSON.parse(plugin.files['orca-plugin.json']).contributes).toEqual({
      themes: [{ id: 'night', title: 'Night', path: 'themes/night.json' }],
      terminalThemes: [{ id: 'night-terminal', title: 'Night', path: 'terminal/night.json' }]
    })
  })

  it('reads localized labels, legacy settings rules and an untyped light theme', () => {
    const label = 'An Extremely Long Theme Label That Keeps Going And Going Past Limits'
    const dir = folder({
      'package.json': JSON.stringify({
        contributes: {
          themes: [
            { label: '%light.label%', path: './light.json' },
            { label, path: './long.json' },
            { label: 'Legacy', path: './legacy.tmTheme' }
          ]
        }
      }),
      'package.nls.json': JSON.stringify({ 'light.label': 'Paper' }),
      'light.json': JSON.stringify({
        colors: { 'editor.background': '#fff', 'terminal.ansiRed': '#c00000' },
        settings: [{ scope: 'comment', settings: { foreground: '#008000' } }]
      }),
      'long.json': JSON.stringify({ type: 'dark', colors: { 'terminal.ansiRed': '#ff5555' } })
    })
    const set = readVscodeThemes(dir)
    expect(set.themes.map((theme) => [theme.label, theme.base])).toEqual([
      ['Paper', 'light'],
      [label, 'dark']
    ])
    expect(set.warnings).toEqual([expect.stringContaining('legacy.tmTheme: skipped')])
    const plugin = renderVscodeThemePlugin(set, identity)
    expect(JSON.parse(plugin.files['themes/paper.json']).tokenColors).toEqual([
      { scope: 'comment', settings: { foreground: '#008000' } }
    ])
    // The editor foreground fills in the terminal text; ids stay within the 64-character limit.
    const { contributes } = JSON.parse(plugin.files['orca-plugin.json'])
    expect(contributes.terminalThemes).toHaveLength(2)
    for (const entry of [...contributes.themes, ...contributes.terminalThemes]) {
      expect(entry.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(entry.id.length).toBeLessThanOrEqual(64)
    }
  })

  it('refuses an include outside the imported folder', () => {
    const dir = folder({ 'theme.json': JSON.stringify({ include: '../elsewhere.json' }) })
    expect(() => readVscodeThemes(join(dir, 'theme.json'))).toThrow(VscodeThemeReadError)
  })

  it('keeps the last style of each scope and drops descendant selectors', () => {
    const warnings: string[] = []
    const rules = compactTokenColors(
      [
        { name: 'defaults', settings: { foreground: '#ffffff', background: '#000000' } },
        { scope: 'string, keyword', settings: { foreground: '#00ff00' } },
        { scope: ['keyword', 'meta.tag string'], settings: { foreground: '#ff0000' } }
      ],
      warnings,
      'Night'
    )
    expect(rules).toEqual([
      { scope: 'string', settings: { foreground: '#00ff00' } },
      { scope: 'keyword', settings: { foreground: '#ff0000' } }
    ])
    expect(warnings).toEqual(['Night: dropped 1 descendant scope selectors Orca does not read'])
  })
})

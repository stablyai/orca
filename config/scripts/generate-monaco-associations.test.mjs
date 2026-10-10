import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { associationsPath, readMonacoAssociations } from './generate-monaco-associations.mjs'

describe('Monaco filename associations', () => {
  it('matches the installed editor registrations and curated Orca associations', () => {
    expect(
      JSON.parse(readFileSync(associationsPath, 'utf8')),
      'Run node config/scripts/generate-monaco-associations.mjs after changing associations or Monaco'
    ).toEqual(readMonacoAssociations())
  })

  it('keeps built-in Ruby aliases alongside the curated Ruby associations', () => {
    expect(readMonacoAssociations().find((language) => language.id === 'ruby')).toEqual({
      id: 'ruby',
      extensions: expect.arrayContaining([
        '.rb',
        '.rbx',
        '.rjs',
        '.gemspec',
        '.pp',
        '.rake',
        '.ru',
        '.jbuilder',
        '.thor'
      ]),
      filenames: expect.arrayContaining([
        'rakefile',
        'Gemfile',
        'Guardfile',
        'Capfile',
        'Podfile',
        'Brewfile',
        'Vagrantfile'
      ])
    })
  })
})

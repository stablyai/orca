import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { associationsPath, readMonacoAssociations } from './generate-monaco-associations.mjs'

describe('Monaco filename associations', () => {
  it('matches every registration shipped by the installed editor entry point', () => {
    expect(
      JSON.parse(readFileSync(associationsPath, 'utf8')),
      'Run node config/scripts/generate-monaco-associations.mjs after upgrading Monaco'
    ).toEqual(readMonacoAssociations())
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Linux computer-use accessibility enable', () => {
  it('exports enableLinuxComputerUseAccessibility and wires it from main index', () => {
    const configure = readFileSync(join(__dirname, 'configure-process.ts'), 'utf8')
    expect(configure).toContain('export function enableLinuxComputerUseAccessibility')
    expect(configure).toContain("force-renderer-accessibility")
    expect(configure).toContain('accessibilitySupportEnabled')
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    expect(index).toContain('enableLinuxComputerUseAccessibility()')
  })
})

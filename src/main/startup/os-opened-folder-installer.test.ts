import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('folder Explorer verbs', () => {
  it('registers and removes both verbs without replacing default associations', () => {
    const hooks = readFileSync('config/nsis/orca-installer-hooks.nsh', 'utf8')
      .split(/\r?\n/)
      .filter((line) => !/^\s*;/.test(line))
      .join('\n')
    const label = 'Open with ${PRODUCT_NAME}'
    for (const [key, argument] of [
      ['Directory', '%1'],
      [String.raw`Directory\Background`, '%V.']
    ]) {
      const registryPath = `Software\\Classes\\${key}\\shell\\Orca`
      expect(hooks).toContain(`WriteRegStr SHELL_CONTEXT "${registryPath}" "" "${label}"`)
      expect(hooks).toContain(
        `WriteRegStr SHELL_CONTEXT "${registryPath}\\command" "" '"$appExe" "${argument}"'`
      )
      expect(hooks).toContain(`DeleteRegKey SHELL_CONTEXT "${registryPath}"`)
    }
    expect(hooks).not.toMatch(/WriteRegStr SHELL_CONTEXT "Software\\Classes\\\.[^"]+" ""/)
    expect(hooks).not.toMatch(/WriteRegStr SHELL_CONTEXT "Software\\Classes\\Directory" ""/)
  })
})

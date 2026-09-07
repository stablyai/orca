import { describe, expect, it } from 'vitest'
import { CLI_COMMAND_NAMES } from '../main/startup/cli-command-names'
import { COMMAND_SPECS } from './specs'

const specCommandNames = [...new Set(COMMAND_SPECS.map((spec) => spec.path[0]))].sort()

describe('CLI command-name parity between COMMAND_SPECS and the launch redirect', () => {
  it('has commands to compare', () => {
    expect(specCommandNames.length).toBeGreaterThan(0)
  })

  it('redirects every top-level CLI command', () => {
    const redirected = new Set<string>(CLI_COMMAND_NAMES)
    expect(specCommandNames.filter((name) => !redirected.has(name))).toEqual([])
  })

  it('lists no command that COMMAND_SPECS does not define', () => {
    const specNames = new Set(specCommandNames)
    expect([...CLI_COMMAND_NAMES].filter((name) => !specNames.has(name))).toEqual([])
  })

  it('stays sorted and free of duplicates so additions are easy to review', () => {
    expect([...CLI_COMMAND_NAMES]).toEqual([...new Set(CLI_COMMAND_NAMES)].sort())
  })
})

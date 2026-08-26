import { describe, expect, it } from 'vitest'
import { PACKAGED_LINUX_CLI_COMMAND_NAMES } from '../shared/packaged-linux-cli-command-names'
import { COMMAND_SPECS } from './specs'

describe('packaged Linux CLI command names', () => {
  it('matches the registered top-level commands in both directions', () => {
    const registeredNames = [...new Set(COMMAND_SPECS.map((spec) => spec.path[0]))].sort()

    expect([...PACKAGED_LINUX_CLI_COMMAND_NAMES].sort()).toEqual(registeredNames)
  })
})

import { describe, expect, it } from 'vitest'
import { CLI_COMMAND_NAMES } from '../../main/startup/cli-command-names'
import { COMMAND_SPECS } from './index'

describe('CLI launch redirect command names', () => {
  it('lists every CLI command, so a direct binary launch never boots the desktop app', () => {
    const roots = new Set(COMMAND_SPECS.map((spec) => spec.path[0]))
    expect([...roots].filter((root) => !CLI_COMMAND_NAMES.some((name) => name === root))).toEqual(
      []
    )
  })
})

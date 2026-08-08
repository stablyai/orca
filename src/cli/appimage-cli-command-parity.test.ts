import { describe, expect, it } from 'vitest'
import { COMMAND_SPECS } from './index'
import { APPIMAGE_CLI_COMMAND_NAMES } from '../shared/appimage-cli-command-names'
import { specPaths } from './args'

/**
 * Why: main cannot import the CLI package, so AppImage CLI redirect keeps a
 * hand-maintained top-level command allow-list. This test fails when a new
 * top-level command lands without updating that list (#13004).
 */
describe('AppImage CLI command allow-list parity', () => {
  it('covers every top-level COMMAND_SPECS path', () => {
    const topLevel = new Set(
      COMMAND_SPECS.flatMap((spec) => specPaths(spec).map((path) => path[0])).filter(
        (name): name is string => typeof name === 'string' && name.length > 0
      )
    )
    const allow = new Set(APPIMAGE_CLI_COMMAND_NAMES)

    const missing = [...topLevel].filter((name) => !allow.has(name)).sort()
    const extra = [...allow].filter((name) => !topLevel.has(name)).sort()

    expect({ missing, extra }).toEqual({ missing: [], extra: [] })
  })
})

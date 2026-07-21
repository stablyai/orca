import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasCustomCodexHomeOverride } from './codex-real-home-path'

describe('hasCustomCodexHomeOverride', () => {
  it('recognizes normalized aliases of Orca-owned CODEX_HOME', () => {
    const managedHome = `${process.cwd()}${sep}codex-runtime-home${sep}home`

    expect(
      hasCustomCodexHomeOverride({
        CODEX_HOME: `${managedHome}${sep}.`,
        ORCA_CODEX_HOME: managedHome
      })
    ).toBe(false)
  })

  it('preserves a genuinely custom CODEX_HOME', () => {
    expect(
      hasCustomCodexHomeOverride({
        CODEX_HOME: `${process.cwd()}${sep}custom-codex-home`,
        ORCA_CODEX_HOME: `${process.cwd()}${sep}codex-runtime-home${sep}home`
      })
    ).toBe(true)
  })
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getEffectiveKeybindingsForAction } from '../../shared/keybindings'
import { getUserKeybindingsPath, writeKeybindingOverride } from './keybinding-file'
import { KeybindingService } from './keybinding-service'

// Verify effective bindings and keystroke matching for fresh/existing cohorts across all platforms.

function makeCohort(pending: boolean): {
  controller: { isPending: () => boolean; markSeeded: () => void }
  seeded: () => boolean
} {
  let stillPending = pending
  let didSeed = false
  return {
    controller: {
      isPending: () => stillPending,
      markSeeded: () => {
        didSeed = true
        stillPending = false
      }
    },
    seeded: () => didSeed
  }
}

// Physical bracket codes are layout-independent; Mod maps to the platform modifier.

describe('KeybindingService tab-switch cohort seeding', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-kb-service-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('existing install keeps a rebound action AND pins the pre-swap default on the rest', () => {
    const platform: NodeJS.Platform = 'darwin'
    writeKeybindingOverride(getUserKeybindingsPath(home), platform, 'tab.nextSameType', ['Mod+K'])

    const cohort = makeCohort(true)
    const service = new KeybindingService({
      homePath: home,
      platform,
      legacyTabSwitchSeed: cohort.controller
    })
    const overrides = service.getOverrides()

    expect(getEffectiveKeybindingsForAction('tab.nextSameType', platform, overrides)).toEqual([
      'Mod+K'
    ])
    expect(getEffectiveKeybindingsForAction('tab.previousSameType', platform, overrides)).toEqual([
      'Mod+Shift+BracketLeft'
    ])
    expect(getEffectiveKeybindingsForAction('tab.nextAllTypes', platform, overrides)).toEqual([
      'Mod+Alt+BracketRight'
    ])
    expect(getEffectiveKeybindingsForAction('tab.previousAllTypes', platform, overrides)).toEqual([
      'Mod+Alt+BracketLeft'
    ])
  })

  it('leaves the cohort pending when the seed write fails (retries next launch)', () => {
    // A file at homePath forces mkdir failure; the cohort must remain pending.
    const fileHome = join(home, 'not-a-dir')
    writeFileSync(fileHome, 'x', 'utf8')
    const cohort = makeCohort(true)

    expect(
      () =>
        new KeybindingService({
          homePath: fileHome,
          platform: 'darwin',
          legacyTabSwitchSeed: cohort.controller
        })
    ).not.toThrow()
    expect(cohort.seeded()).toBe(false)
    expect(cohort.controller.isPending()).toBe(true)
  })
})

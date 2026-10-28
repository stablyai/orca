import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getEffectiveKeybindingsForAction,
  keybindingMatchesAction,
  LEGACY_TAB_SWITCH_BINDINGS,
  type KeybindingActionId,
  type KeybindingInput
} from '../../shared/keybindings'
import { getUserKeybindingsPath, writeKeybindingOverride } from './keybinding-file'
import { KeybindingService } from './keybinding-service'

// Verify effective bindings and keystroke matching for fresh/existing cohorts across all platforms.

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'linux', 'win32']
const SWAPPED_ACTIONS = Object.keys(LEGACY_TAB_SWITCH_BINDINGS) as KeybindingActionId[]

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
function bracketPress(opts: {
  code: 'BracketLeft' | 'BracketRight'
  alt: boolean
  shift: boolean
  platform: NodeJS.Platform
}): KeybindingInput {
  const isMac = opts.platform === 'darwin'
  return {
    code: opts.code,
    key: opts.code === 'BracketRight' ? ']' : '[',
    meta: isMac,
    control: !isMac,
    alt: opts.alt,
    shift: opts.shift
  }
}

describe('KeybindingService tab-switch cohort seeding', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-kb-service-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it.each(PLATFORMS)(
    'fresh install (%s) adopts the swapped defaults and writes no file',
    (platform) => {
      const cohort = makeCohort(false)
      const service = new KeybindingService({
        homePath: home,
        platform,
        legacyTabSwitchSeed: cohort.controller
      })

      expect(cohort.seeded()).toBe(false)
      expect(existsSync(getUserKeybindingsPath(home))).toBe(false)

      const overrides = service.getOverrides()
      expect(getEffectiveKeybindingsForAction('tab.nextAllTypes', platform, overrides)).toEqual([
        'Mod+Shift+BracketRight'
      ])
      expect(getEffectiveKeybindingsForAction('tab.nextSameType', platform, overrides)).toEqual([
        'Mod+Alt+BracketRight'
      ])

      expect(
        keybindingMatchesAction(
          'tab.nextAllTypes',
          bracketPress({ code: 'BracketRight', alt: false, shift: true, platform }),
          platform,
          overrides
        )
      ).toBe(true)
      expect(
        keybindingMatchesAction(
          'tab.nextSameType',
          bracketPress({ code: 'BracketRight', alt: false, shift: true, platform }),
          platform,
          overrides
        )
      ).toBe(false)
    }
  )

  it.each(PLATFORMS)(
    'existing install (%s) keeps the pre-swap chords exactly, on a clean profile',
    (platform) => {
      const cohort = makeCohort(true)
      const service = new KeybindingService({
        homePath: home,
        platform,
        legacyTabSwitchSeed: cohort.controller
      })

      expect(cohort.seeded()).toBe(true)
      const overrides = service.getOverrides()

      for (const actionId of SWAPPED_ACTIONS) {
        expect(getEffectiveKeybindingsForAction(actionId, platform, overrides)).toEqual(
          LEGACY_TAB_SWITCH_BINDINGS[actionId]
        )
      }

      // Existing installs keep the inverse of fresh-install tab-switch defaults.
      const shiftRight = bracketPress({ code: 'BracketRight', alt: false, shift: true, platform })
      expect(keybindingMatchesAction('tab.nextSameType', shiftRight, platform, overrides)).toBe(
        true
      )
      expect(keybindingMatchesAction('tab.nextAllTypes', shiftRight, platform, overrides)).toBe(
        false
      )

      const altLeft = bracketPress({ code: 'BracketLeft', alt: true, shift: false, platform })
      expect(keybindingMatchesAction('tab.previousAllTypes', altLeft, platform, overrides)).toBe(
        true
      )
      expect(keybindingMatchesAction('tab.previousSameType', altLeft, platform, overrides)).toBe(
        false
      )
    }
  )

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

  it('is idempotent: a second launch after the seed changes nothing', () => {
    const platform: NodeJS.Platform = 'linux'
    const cohort = makeCohort(true)
    const first = new KeybindingService({
      homePath: home,
      platform,
      legacyTabSwitchSeed: cohort.controller
    })
    const afterFirst = first.getOverrides()

    // Reuse the cohort after markSeeded to model the persisted done flag.
    const second = new KeybindingService({
      homePath: home,
      platform,
      legacyTabSwitchSeed: cohort.controller
    })
    expect(second.getOverrides()).toEqual(afterFirst)
    for (const actionId of SWAPPED_ACTIONS) {
      expect(getEffectiveKeybindingsForAction(actionId, platform, second.getOverrides())).toEqual(
        LEGACY_TAB_SWITCH_BINDINGS[actionId]
      )
    }
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

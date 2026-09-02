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

// End-to-end coverage of the tab-switch convention swap: constructs a real
// KeybindingService (which runs the seed) and asserts the effective bindings AND
// real keystroke matching for both cohorts. The load-bearing claim under test is
// that a pre-existing install's behavior is byte-identical to what it was before
// the swap, on every platform and every customization state.

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

// A physical bracket press. Mod is Cmd on macOS and Ctrl elsewhere; the matcher
// resolves brackets by `code`, so this stays layout-independent.
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
      // Nothing written: a fresh install rides on the registry defaults.
      expect(existsSync(getUserKeybindingsPath(home))).toBe(false)

      const overrides = service.getOverrides()
      expect(getEffectiveKeybindingsForAction('tab.nextAllTypes', platform, overrides)).toEqual([
        'Mod+Shift+BracketRight'
      ])
      expect(getEffectiveKeybindingsForAction('tab.nextSameType', platform, overrides)).toEqual([
        'Mod+Alt+BracketRight'
      ])

      // Shift+bracket now drives the broad all-types cycle.
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

      // Effective bindings for all four actions equal the pre-swap defaults.
      for (const actionId of SWAPPED_ACTIONS) {
        expect(getEffectiveKeybindingsForAction(actionId, platform, overrides)).toEqual(
          LEGACY_TAB_SWITCH_BINDINGS[actionId]
        )
      }

      // Behavior is unchanged: Mod+Shift+bracket still cycles same-type, and
      // Mod+Alt+bracket still cycles all-types — the inverse of a fresh install.
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
    // The user had rebound just one action before upgrading.
    writeKeybindingOverride(getUserKeybindingsPath(home), platform, 'tab.nextSameType', ['Mod+K'])

    const cohort = makeCohort(true)
    const service = new KeybindingService({
      homePath: home,
      platform,
      legacyTabSwitchSeed: cohort.controller
    })
    const overrides = service.getOverrides()

    // Their custom binding is untouched...
    expect(getEffectiveKeybindingsForAction('tab.nextSameType', platform, overrides)).toEqual([
      'Mod+K'
    ])
    // ...and the other three still resolve to their pre-swap defaults, not the
    // new ones — no silent behavior change for a partially-customized user.
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

    // Same cohort controller: markSeeded flipped it to not-pending, mirroring the
    // persisted flag flipping to 'done'.
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
    // homePath is a regular file, so creating `<home>/.orca/` throws. The service
    // must swallow the error and NOT mark the one-shot done.
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

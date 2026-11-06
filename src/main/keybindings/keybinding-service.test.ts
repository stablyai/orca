import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getEffectiveKeybindingsForAction, keybindingMatchesAction } from '../../shared/keybindings'
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

describe('KeybindingService cohort seeding', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-kb-service-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('pins old search/clear bindings once and keeps a later reset across launches', () => {
    const cohort = makeCohort(true)
    const options = {
      homePath: home,
      platform: 'darwin' as const,
      searchKeybindingSeed: cohort.controller
    }
    const service = new KeybindingService(options)
    expect(service.getOverrides()).toEqual({
      'worktree.palette': ['Mod+J'],
      'terminal.clear': ['Mod+K']
    })
    expect(cohort.seeded()).toBe(true)

    service.setActionBindings('worktree.palette', null)
    const reopened = new KeybindingService(options)
    const cmdK = { key: 'k', code: 'KeyK', meta: true, control: false, alt: false, shift: false }
    expect(
      keybindingMatchesAction('worktree.palette', cmdK, 'darwin', reopened.getOverrides())
    ).toBe(true)
    expect(reopened.getOverrides()).toEqual({ 'terminal.clear': ['Mod+K'] })
  })

  it('preserves common, disabled and other-platform choices when upgrading search', () => {
    mkdirSync(join(home, '.orca'))
    writeFileSync(
      getUserKeybindingsPath(home),
      JSON.stringify({
        keybindings: { 'worktree.palette': ['Mod+Alt+J'] },
        platforms: {
          darwin: { 'terminal.clear': [] },
          win32: { 'worktree.palette': ['Mod+Shift+J'] }
        }
      })
    )
    const service = new KeybindingService({
      homePath: home,
      platform: 'darwin',
      searchKeybindingSeed: makeCohort(true).controller
    })
    expect(service.getOverrides()).toEqual({
      'worktree.palette': ['Mod+Alt+J'],
      'terminal.clear': []
    })
    expect(service.getSnapshot().platformOverrides.win32).toEqual({
      'worktree.palette': ['Mod+Shift+J']
    })
  })

  it('leaves new profiles and non-Mac profiles without legacy search pins', () => {
    const fresh = new KeybindingService({
      homePath: home,
      platform: 'darwin',
      searchKeybindingSeed: makeCohort(false).controller
    })
    expect(fresh.getOverrides()).toEqual({})
    const windows = new KeybindingService({
      homePath: home,
      platform: 'win32',
      searchKeybindingSeed: makeCohort(true).controller
    })
    expect(windows.getOverrides()).toEqual({})
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
    const searchCohort = makeCohort(true)

    expect(
      () =>
        new KeybindingService({
          homePath: fileHome,
          platform: 'darwin',
          legacyTabSwitchSeed: cohort.controller,
          searchKeybindingSeed: searchCohort.controller
        })
    ).not.toThrow()
    expect(cohort.seeded()).toBe(false)
    expect(cohort.controller.isPending()).toBe(true)
    expect(searchCohort.controller.isPending()).toBe(true)
  })
})

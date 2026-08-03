// Phase 4 launch-plan purity. Pure function, no I/O — so the Git denylist and
// the absence of any permission-bypass flag are both trivially assertable.
import { describe, expect, it } from 'vitest'
import {
  buildClaudeLaunchPlan,
  DENIED_GIT_TOOL_PATTERNS,
  FORBIDDEN_PERMISSION_FLAGS
} from './audited-claude-launch-plan'

const SETTINGS_PATH = '/tmp/run/settings.json'

function planFor(mode: 'plan' | 'direct'): ReturnType<typeof buildClaudeLaunchPlan> {
  return buildClaudeLaunchPlan({ mode, model: 'claude-sonnet-5', settingsPath: SETTINGS_PATH })
}

describe('plan mode', () => {
  it('is read-only via --permission-mode plan', () => {
    const { argv } = planFor('plan')
    expect(argv).toContain('--permission-mode')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan')
  })

  it('requests text output and non-interactive mode', () => {
    const { argv } = planFor('plan')
    expect(argv).toContain('-p')
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('text')
  })

  it('needs no denylist because it cannot write at all', () => {
    const { argv } = planFor('plan')
    expect(argv).not.toContain('--disallowedTools')
  })
})

describe('direct mode', () => {
  it('allows edits via acceptEdits', () => {
    const { argv } = planFor('direct')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  })

  it('denies every Git write verb on the command line', () => {
    const { argv } = planFor('direct')
    for (const pattern of DENIED_GIT_TOOL_PATTERNS) {
      expect(argv).toContain(pattern)
    }
  })

  it('repeats the denylist in a run-scoped settings file, so neither alone is load-bearing', () => {
    const { argv, settings } = planFor('direct')
    expect(argv[argv.indexOf('--settings') + 1]).toBe(SETTINGS_PATH)
    expect(settings.permissions.deny).toEqual([...DENIED_GIT_TOOL_PATTERNS])
  })

  it('covers commit, push, merge, rebase, reset, checkout, stash, and clean', () => {
    const verbs = ['commit', 'push', 'merge', 'rebase', 'reset', 'checkout', 'stash', 'clean']
    for (const verb of verbs) {
      expect(DENIED_GIT_TOOL_PATTERNS).toContain(`Bash(git ${verb}:*)`)
    }
  })
})

describe('permission bypass flags never appear', () => {
  it.each(['plan', 'direct'] as const)('%s mode carries no bypass flag', (mode) => {
    const { argv, settings } = planFor(mode)
    const serialized = `${argv.join(' ')} ${JSON.stringify(settings)}`
    for (const flag of FORBIDDEN_PERMISSION_FLAGS) {
      expect(serialized).not.toContain(flag)
    }
  })
})

describe('purity', () => {
  it('returns an identical plan for identical inputs', () => {
    expect(planFor('direct')).toEqual(planFor('direct'))
  })
})

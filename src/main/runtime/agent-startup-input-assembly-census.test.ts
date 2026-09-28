import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '../../..')

/**
 * The host modules that turn settings into `buildAgentStartupPlan` inputs.
 *
 * `buildAgentStartupPlan` was always shared; the input assembly was not, and the hand-rolled
 * copies drifted — one dropped `sessionOptionsOverrideAgentArgs` and let configured args defeat a
 * picked model. This pins the funnel so a sixth host site cannot re-derive the inputs by hand.
 */
const MIGRATED_HOST_LAUNCH_MODULES = [
  'src/main/runtime/orca-runtime-create-agent-session.ts',
  'src/main/runtime/orca-runtime-resolve-mobile-session-terminal-command.ts',
  'src/main/runtime/orca-runtime-resolve-worktree-removal-target.ts',
  'src/main/runtime/runtime-worktree-agent-startup.ts'
]

/** Reading any of these next to a startup plan means the inputs are being assembled by hand. */
const HAND_ASSEMBLY_MARKERS = [
  'resolveTuiAgentLaunchArgs(',
  'resolveTuiAgentLaunchEnv(',
  'resolveLocalWindowsAgentStartupShell('
]

function read(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
}

describe('host agent-startup input assembly census', () => {
  it('routes every migrated host launch site through the shared resolver', () => {
    const missing = MIGRATED_HOST_LAUNCH_MODULES.filter(
      (file) => !read(file).includes('resolveAgentStartupPlanInputs(')
    )
    expect(missing).toEqual([])
  })

  it('leaves no migrated host site assembling the settings-derived inputs by hand', () => {
    const handAssembled = MIGRATED_HOST_LAUNCH_MODULES.filter((file) => {
      const source = read(file)
      return HAND_ASSEMBLY_MARKERS.some((marker) => source.includes(marker))
    })
    expect(handAssembled).toEqual([])
  })

  it('detects hand assembly when it is present', () => {
    // Positive control: the markers are real names, so an empty result above is a true negative
    // rather than a typo that can never match.
    const resumeSite = read(
      'src/main/runtime/orca-runtime-get-agent-session-execution-namespace.ts'
    )
    expect(HAND_ASSEMBLY_MARKERS.some((marker) => resumeSite.includes(marker))).toBe(true)
  })
})

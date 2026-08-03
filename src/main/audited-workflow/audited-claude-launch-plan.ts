// Builds the argv and run-scoped settings for an audited Claude launch. PURE —
// no I/O, no filesystem, no spawn — so the Git denylist has exactly one
// definition and is trivially testable.
//
// THIS IS NOT CONTAINMENT. The denylist is a best-effort cost-raiser that
// cannot enumerate every route to a Git write (see UNCOVERED_BYPASS_VECTORS
// below). The authoritative mechanism is post-run drift detection in
// audited-worktree-drift-verifier.ts, which compares actual HEAD and branch tip
// against the persisted base commit and is therefore indifferent to how a commit
// was invoked.
import type { ExecutionMode } from '../../shared/audited-execution-types'

// The Git write verbs denied at launch. Patterns match Claude's tool-permission
// syntax; each covers the plain `git <verb>` invocation only.
export const DENIED_GIT_TOOL_PATTERNS: readonly string[] = [
  'Bash(git commit:*)',
  'Bash(git push:*)',
  'Bash(git merge:*)',
  'Bash(git rebase:*)',
  'Bash(git reset:*)',
  'Bash(git checkout:*)',
  'Bash(git stash:*)',
  'Bash(git clean:*)',
  'Bash(git tag:*)',
  'Bash(git branch:*)',
  'Bash(git cherry-pick:*)',
  'Bash(git am:*)',
  'Bash(git apply:*)',
  'Bash(git revert:*)'
]

// Documented, PROVABLY uncovered routes to a Git write. Recorded here so the
// adversarial test can assert them as expected-uncovered — if anyone later
// claims containment, that test fails. Broadening the patterns narrows the gap
// but never closes it.
export const UNCOVERED_BYPASS_VECTORS: readonly string[] = [
  'git -C /other/path commit',
  '/usr/bin/git commit',
  'C:\\Program Files\\Git\\bin\\git.exe commit',
  'cd elsewhere && git commit',
  "sh -c 'git commit'",
  'bash -lc "git commit"',
  '$(which git) commit',
  'GIT_DIR=/other/.git git commit'
]

// Permission-bypass flags that must NEVER appear in an audited launch. They
// exist in Orca only for interactive launches.
export const FORBIDDEN_PERMISSION_FLAGS: readonly string[] = [
  '--dangerously-skip-permissions',
  'bypassPermissions',
  '--permission-mode=bypassPermissions'
]

export type ClaudeLaunchPlan = {
  argv: string[]
  /** Written to a run-scoped file by the caller; never a shared user settings file. */
  settings: { permissions: { deny: string[] } }
}

export type BuildLaunchPlanArgs = {
  mode: ExecutionMode
  model: string
  /** Absolute path the caller will write `settings` to. Direct mode only. */
  settingsPath: string
}

/**
 * plan mode is read-only: `--permission-mode plan` makes Claude produce a plan as
 * TEXT ON STDOUT — it does not write a plan file, and it needs no denylist
 * because it cannot write at all.
 *
 * direct mode allows edits and denies Git writes twice over: `--disallowedTools`
 * plus a run-scoped `--settings` deny block, so neither alone is load-bearing.
 */
export function buildClaudeLaunchPlan(args: BuildLaunchPlanArgs): ClaudeLaunchPlan {
  const base = ['-p', '--output-format', 'text']
  if (args.mode === 'plan') {
    return {
      argv: [...base, '--permission-mode', 'plan', '--model', args.model],
      settings: { permissions: { deny: [] } }
    }
  }
  return {
    argv: [
      ...base,
      '--permission-mode',
      'acceptEdits',
      '--model',
      args.model,
      '--settings',
      args.settingsPath,
      '--disallowedTools',
      ...DENIED_GIT_TOOL_PATTERNS
    ],
    settings: { permissions: { deny: [...DENIED_GIT_TOOL_PATTERNS] } }
  }
}

/**
 * Whether the denylist covers a literal command string. Used by the adversarial
 * test to separate covered vectors from the documented uncovered ones — it is
 * NOT a runtime guard and nothing in the execution path calls it to decide
 * whether a command may run.
 */
export function isDeniedByLaunchPlanPatterns(command: string): boolean {
  const normalized = command.trim()
  return DENIED_GIT_TOOL_PATTERNS.some((pattern) => {
    const verb = pattern.slice('Bash('.length, pattern.indexOf(':*)'))
    return normalized === verb || normalized.startsWith(`${verb} `)
  })
}

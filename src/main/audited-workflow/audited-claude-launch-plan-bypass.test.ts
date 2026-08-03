// Phase 4 adversarial launch-plan test.
//
// This suite exists to keep the project HONEST about what the denylist does. It
// asserts BOTH directions: the plain `git <verb>` forms the patterns do cover,
// AND the documented vectors they provably cannot. If someone later broadens the
// patterns and claims containment, the expected-uncovered half fails.
//
// What actually catches these vectors is post-run drift detection, which is
// state-based (compares HEAD and branch tip to the persisted base commit) and so
// is indifferent to how a commit was invoked. See
// audited-execution-git-boundary.test.ts.
import { describe, expect, it } from 'vitest'
import {
  isDeniedByLaunchPlanPatterns,
  UNCOVERED_BYPASS_VECTORS
} from './audited-claude-launch-plan'

const COVERED_VECTORS = [
  'git commit -m x',
  'git push origin main',
  'git merge feature',
  'git rebase main',
  'git reset --hard HEAD',
  'git checkout main',
  'git stash push',
  'git clean -fd',
  'git tag v1',
  'git branch -D x'
]

describe('vectors the denylist DOES cover', () => {
  it.each(COVERED_VECTORS)('denies %s', (command) => {
    expect(isDeniedByLaunchPlanPatterns(command)).toBe(true)
  })
})

describe('vectors the denylist provably CANNOT cover', () => {
  // Each is recorded as expected-uncovered. A change that makes one "covered"
  // must be accompanied by a deliberate update here — it must never be read as
  // evidence that Phase 4 achieved containment, because it did not.
  it.each(UNCOVERED_BYPASS_VECTORS)('does not deny %s (expected-uncovered)', (command) => {
    expect(isDeniedByLaunchPlanPatterns(command)).toBe(false)
  })

  it('documents every bypass class named in the plan', () => {
    const joined = UNCOVERED_BYPASS_VECTORS.join('\n')
    expect(joined).toContain('git -C ') // directory redirection
    expect(joined).toContain('/usr/bin/git') // absolute binary path
    expect(joined).toContain('git.exe') // Windows absolute path
    expect(joined).toContain('&&') // shell chaining
    expect(joined).toContain('sh -c') // shell wrapper
    expect(joined).toContain('bash -lc') // login-shell wrapper
    expect(joined).toContain('$(which git)') // command substitution
    expect(joined).toContain('GIT_DIR=') // env-var indirection
  })

  it('is a non-empty set — the denylist is never complete', () => {
    expect(UNCOVERED_BYPASS_VECTORS.length).toBeGreaterThan(0)
  })
})

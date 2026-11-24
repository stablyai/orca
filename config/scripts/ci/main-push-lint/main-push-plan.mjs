// Decide what a main push lints: the source files it changed, plus every file a changed lint policy governs.
// A policy change can pass on its PR's older main and still fail files that landed since, so it re-lints its scope.
import { policyChanges } from './oxlint-policy.mjs'
import { changedPaths, isLintable } from './main-push-range.mjs'

const ROOT = '.'

export { oxlintVersionFromLockfile } from './oxlint-policy.mjs'

export function isUnder(file, dir) {
  return dir === ROOT || file === dir || file.startsWith(`${dir}/`)
}

// Directories to walk, with any directory inside another dropped; a root policy change walks the whole tree.
function outermost(dirs) {
  const unique = [...new Set(dirs)].toSorted((a, b) => a.length - b.length)
  return unique.filter((dir, index) => !unique.slice(0, index).some((outer) => isUnder(dir, outer)))
}

export async function planLint({ base, head, cwd }) {
  const { changes, unrepresentable } = await changedPaths(base, head, cwd)
  const policies = await policyChanges(changes, { base, head, cwd, unrepresentable })
  const dirs = outermost(policies.map((policy) => policy.dir))
  const touched = changes
    .filter((change) => change.status !== 'D' && isLintable(change.path))
    .map((change) => change.path)
  return {
    touched,
    // Every touched file is named, even inside a walked directory: a nested .eslintignore or .gitignore can
    // hide it from oxlint's walk, while a named file is linted. oxlint reports a file once per run either way.
    files: touched,
    // Touched files also inside a walked directory: oxlint may count these twice, and two runs may both report them.
    overlap: touched.filter((file) => dirs.some((dir) => isUnder(file, dir))),
    dirs,
    policies,
    // A deleted path has nothing to lint, whatever its bytes.
    unrepresentable: unrepresentable
      .filter((change) => change.status !== 'D' && isLintable(change.path))
      .map((change) => change.path)
  }
}

export function isEmptyPlan(plan) {
  return plan.files.length === 0 && plan.dirs.length === 0 && plan.unrepresentable.length === 0
}

// Every policy change whose scope holds a file the push did not touch, deepest scope first.
export function governingPolicies(file, policies) {
  return policies
    .filter((policy) => isUnder(file, policy.dir))
    .toSorted((a, b) => b.dir.length - a.dir.length)
}

// Decide what a main push lints: the source files it changed, plus every file a changed lint policy governs.
// A policy change can pass on its PR's older main and still fail files that landed since, so it re-lints its scope.
import { execFile } from 'node:child_process'
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

// The files Git's ignore rules match, tracked or not. oxlint's directory walk skips exactly these (nested
// .gitignore files included), while a file named on its command line is linted regardless.
function gitIgnored(files, cwd) {
  if (files.length === 0) {
    return Promise.resolve(new Set())
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['check-ignore', '--no-index', '-z', '--stdin'],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        // Exit 1 means no path matched.
        if (error && error.code !== 1) {
          reject(error)
          return
        }
        resolve(new Set(String(stdout).split('\0').filter(Boolean)))
      }
    )
    child.stdin.end(`${files.join('\0')}\0`)
  })
}

export async function planLint({ base, head, cwd }) {
  const { changes, unrepresentable } = await changedPaths(base, head, cwd)
  const policies = await policyChanges(changes, { base, head, cwd })
  const dirs = outermost(policies.map((policy) => policy.dir))
  const touched = changes
    .filter((change) => change.status !== 'D' && isLintable(change.path))
    .map((change) => change.path)
  const walked = new Set(touched.filter((file) => dirs.some((dir) => isUnder(file, dir))))
  const skippedByWalk = await gitIgnored([...walked], cwd)
  return {
    touched,
    // A touched file the walk covers is not passed twice; one the walk skips as Git-ignored still is.
    files: touched.filter((file) => !walked.has(file) || skippedByWalk.has(file)),
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

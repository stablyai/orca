// Decide what a main push lints: the source files it changed, plus every file a changed lint policy governs.
// A policy change can pass on its PR's older main and still fail files that landed since, so it re-lints its scope.
import path from 'node:path'
import { changedPaths, EMPTY_TREE_SHA, git, isLintable } from './main-push-range.mjs'

const CONFIG_NAME = '.oxlintrc.json'
const LOCKFILE = 'pnpm-lock.yaml'
const ROOT = '.'

function configDir(file) {
  return path.posix.dirname(file)
}

function isConfig(file) {
  return path.posix.basename(file) === CONFIG_NAME
}

export function isUnder(file, dir) {
  return dir === ROOT || file === dir || file.startsWith(`${dir}/`)
}

// The oxlint version the lockfile resolves for the root package.
export function oxlintVersionFromLockfile(text) {
  return /^ {6}oxlint:\n {8}specifier: .*\n {8}version: ([^\s(]+)/m.exec(text ?? '')?.[1] ?? null
}

async function show(rev, file, cwd) {
  if (rev === EMPTY_TREE_SHA) {
    return null
  }
  try {
    return await git(['show', `${rev}:${file}`], cwd)
  } catch {
    return null
  }
}

// What each config, and each file a config extends, itself extends. oxlint resolves `extends` recursively and
// any file can be extended, whatever its name, so every referenced file is read too. Each file is read once.
async function extendsGraph(head, cwd) {
  const files = (await git(['ls-tree', '-r', '-z', '--name-only', head], cwd)).split('\0')
  const configs = files.filter(isConfig)
  const graph = new Map()
  const queue = [...configs]
  while (queue.length > 0) {
    const file = queue.shift()
    if (graph.has(file)) {
      continue
    }
    let entries = []
    try {
      entries = JSON.parse(await show(head, file, cwd))?.extends ?? []
    } catch {
      // A missing or unreadable file extends nothing here; oxlint reports it when it loads the config.
    }
    const targets = (Array.isArray(entries) ? entries : []).map((entry) =>
      path.posix.normalize(path.posix.join(configDir(file), String(entry)))
    )
    graph.set(file, targets)
    queue.push(...targets)
  }
  return { configs, graph }
}

// Each changed policy input and the directory whose files it governs. A config that extends a changed file,
// directly or through any chain of extended files, governs its own directory too.
const VERB = { A: 'was added', D: 'was deleted' }

async function policyChanges(changes, { base, head, cwd }) {
  const changed = new Set(changes.map((change) => change.path))
  const policies = []
  for (const { status, path: file } of changes) {
    if (isConfig(file)) {
      policies.push({
        dir: configDir(file),
        path: file,
        why: `${file} ${VERB[status] ?? 'changed'}`
      })
    }
  }
  // Spread "depends on a changed file" up the extends graph; the fixed point also ends any cycle.
  const { configs, graph } = await extendsGraph(head, cwd)
  /** @type {Map<string, { root: string, via: string | null }>} */
  const cause = new Map([...changed].map((file) => [file, { root: file, via: null }]))
  for (let grew = true; grew;) {
    grew = false
    for (const [file, targets] of graph) {
      const hit = cause.has(file) ? undefined : targets.find((target) => cause.has(target))
      if (hit) {
        cause.set(file, { root: cause.get(hit).root, via: hit })
        grew = true
      }
    }
  }
  for (const config of configs) {
    const { root, via } = cause.get(config) ?? {}
    if (via) {
      policies.push({
        dir: configDir(config),
        path: root,
        why:
          via === root
            ? `${config} extends ${via}, which changed`
            : `${config} extends ${via}, which depends on ${root}, which changed`
      })
    }
  }
  if (changed.has(LOCKFILE)) {
    const before = oxlintVersionFromLockfile(await show(base, LOCKFILE, cwd))
    const after = oxlintVersionFromLockfile(await show(head, LOCKFILE, cwd))
    if (before !== after) {
      policies.push({
        dir: ROOT,
        path: LOCKFILE,
        why: `the locked oxlint version changed (${before ?? 'none'} to ${after ?? 'none'})`
      })
    }
  }
  return policies
}

// Directories to walk, with any directory inside another dropped; a root policy change walks the whole tree.
function outermost(dirs) {
  const unique = [...new Set(dirs)].toSorted((a, b) => a.length - b.length)
  return unique.filter((dir, index) => !unique.slice(0, index).some((outer) => isUnder(dir, outer)))
}

export async function planLint({ base, head, cwd }) {
  const { changes, unrepresentable } = await changedPaths(base, head, cwd)
  const policies = await policyChanges(changes, { base, head, cwd })
  const dirs = outermost(policies.map((policy) => policy.dir))
  const touched = changes
    .filter((change) => change.status !== 'D' && isLintable(change.path))
    .map((change) => change.path)
  return {
    touched,
    // Touched files a walked directory already covers are not passed twice.
    files: touched.filter((file) => !dirs.some((dir) => isUnder(file, dir))),
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

// The policy changes that made the lint check a file the push did not touch, deepest scope first.
export function governingPolicies(file, policies) {
  const matching = policies.filter((policy) => isUnder(file, policy.dir))
  const deepest = Math.max(...matching.map((policy) => policy.dir.length))
  return matching.filter((policy) => policy.dir.length === deepest)
}

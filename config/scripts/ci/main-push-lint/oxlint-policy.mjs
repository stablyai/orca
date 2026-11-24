// Which lint policy a main push changed, read the way the pinned oxlint 1.94 finds it: config files by name in
// any directory, JSON configs that may hold comments and trailing commas, `extends` followed through files of
// any name, and symlinked files followed to their target. What cannot be read statically (a script config, a
// config that does not parse, a link out of the repository) counts as changed on every push, so it is linted.
import path from 'node:path'
import { EMPTY_TREE_SHA, git } from './main-push-range.mjs'

// The names oxlint 1.94 discovers. The script forms run JavaScript, so their inputs cannot be read here.
export const CONFIG_NAMES = [
  '.oxlintrc.json',
  '.oxlintrc.jsonc',
  'oxlint.config.ts',
  'oxlint.config.mts'
]
const SCRIPT_CONFIG = /\.m?ts$/
const LOCKFILE = 'pnpm-lock.yaml'
const ROOT = '.'
const SYMLINK_MODE = '120000'
const VERB = { A: 'was added', D: 'was deleted' }

export function isConfig(file) {
  return CONFIG_NAMES.includes(path.posix.basename(file))
}

export function configDir(file) {
  return path.posix.dirname(file)
}

// The oxlint version the lockfile resolves for the root package.
export function oxlintVersionFromLockfile(text) {
  return /^ {6}oxlint:\n {8}specifier: .*\n {8}version: ([^\s(]+)/m.exec(text ?? '')?.[1] ?? null
}

// Calls `keep(char, index)` for each character outside a JSON string; strings pass through untouched.
function outsideStrings(text, keep) {
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"') {
      let end = index + 1
      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1
      }
      out += text.slice(index, end + 1)
      index = end
      continue
    }
    const kept = keep(text[index], index)
    out += kept.text
    index += kept.skip
  }
  return out
}

// JSON with // and /* */ comments and trailing commas, as oxlint reads a JSON config.
export function parseJsonc(text) {
  const withoutComments = outsideStrings(text, (char, index) => {
    if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index)
      return { text: '\n', skip: (end === -1 ? text.length : end) - index }
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      return { text: ' ', skip: (end === -1 ? text.length : end + 1) - index }
    }
    return { text: char, skip: 0 }
  })
  const withoutTrailingCommas = outsideStrings(withoutComments, (char, index) =>
    char === ',' && /^\s*[}\]]/.test(withoutComments.slice(index + 1))
      ? { text: '', skip: 0 }
      : { text: char, skip: 0 }
  )
  return JSON.parse(withoutTrailingCommas)
}

async function listTree(head, cwd) {
  const entries = new Map()
  for (const record of (await git(['ls-tree', '-r', '-z', head], cwd)).split('\0')) {
    const tab = record.indexOf('\t')
    if (tab !== -1) {
      const [mode, , sha] = record.slice(0, tab).split(' ')
      entries.set(record.slice(tab + 1), { mode, sha })
    }
  }
  return entries
}

// A repository path for `target` as written in `from`, or null when it leaves the repository.
function resolveFrom(from, target) {
  if (path.posix.isAbsolute(target)) {
    return null
  }
  const resolved = path.posix.normalize(path.posix.join(configDir(from), target))
  return resolved === '..' || resolved.startsWith('../') ? null : resolved
}

// Every config at head, what each file in the policy graph points at (extends targets and link targets), and
// the files whose inputs cannot be read. Each file is read once, so a cycle ends.
async function policyGraph(head, cwd) {
  const tree = await listTree(head, cwd)
  const configs = [...tree.keys()].filter(isConfig)
  const edges = new Map()
  const unknown = new Map()
  const queue = [...configs]
  while (queue.length > 0) {
    const file = queue.shift()
    if (edges.has(file)) {
      continue
    }
    const entry = tree.get(file)
    let targets = []
    if (!entry) {
      // Missing at head: nothing to follow, though a push that changed it is still a change.
    } else if (entry.mode === SYMLINK_MODE) {
      targets = [resolveFrom(file, (await git(['cat-file', 'blob', entry.sha], cwd)).trim())]
    } else if (SCRIPT_CONFIG.test(file)) {
      unknown.set(file, `${file} is a script config whose inputs cannot be read`)
    } else {
      try {
        const entries = parseJsonc(await git(['cat-file', 'blob', entry.sha], cwd)).extends ?? []
        targets = (Array.isArray(entries) ? entries : [null]).map((target) =>
          typeof target === 'string' ? resolveFrom(file, target) : null
        )
      } catch {
        unknown.set(file, `${file} does not parse as JSON with comments`)
      }
    }
    if (targets.includes(null)) {
      unknown.set(file, `${file} points outside the repository or at an unreadable extends entry`)
    }
    edges.set(file, targets.filter(Boolean))
    queue.push(...targets.filter(Boolean))
  }
  return { configs, edges, unknown }
}

// The changed files and unreadable files a config reaches through the graph, not counting itself.
function reachable(config, { edges, unknown }, changed) {
  const roots = new Set()
  const opaque = new Set()
  const seen = new Set([config])
  const stack = [...(edges.get(config) ?? [])]
  if (unknown.has(config)) {
    opaque.add(config)
  }
  while (stack.length > 0) {
    const file = stack.pop()
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    if (changed.has(file)) {
      roots.add(file)
    }
    if (unknown.has(file)) {
      opaque.add(file)
    }
    stack.push(...(edges.get(file) ?? []))
  }
  return { roots: [...roots].toSorted(), opaque: [...opaque].toSorted() }
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

// Each changed policy input: the directory it governs, the changed files behind it (for attribution) and why.
export async function policyChanges(changes, { base, head, cwd }) {
  const changed = new Set(changes.map((change) => change.path))
  const policies = []
  const direct = new Set()
  for (const { status, path: file } of changes) {
    if (isConfig(file)) {
      direct.add(file)
      policies.push({
        dir: configDir(file),
        paths: [file],
        why: `${file} ${VERB[status] ?? 'changed'}`
      })
    }
  }
  const graph = await policyGraph(head, cwd)
  for (const config of graph.configs) {
    const { roots, opaque } = reachable(config, graph, changed)
    if (roots.length > 0) {
      const extended = graph.edges.get(config) ?? []
      const how = roots.every((root) => extended.includes(root)) ? 'extends' : 'depends on'
      policies.push({
        dir: configDir(config),
        paths: roots,
        why: `${config} ${how} ${roots.join(', ')}, which changed`
      })
    } else if (opaque.length > 0 && !direct.has(config)) {
      policies.push({
        dir: configDir(config),
        paths: [],
        why: `${opaque.map((file) => graph.unknown.get(file)).join('; ')}, so its scope is linted on every push`
      })
    }
  }
  if (changed.has(LOCKFILE)) {
    const before = oxlintVersionFromLockfile(await show(base, LOCKFILE, cwd))
    const after = oxlintVersionFromLockfile(await show(head, LOCKFILE, cwd))
    if (before !== after) {
      policies.push({
        dir: ROOT,
        paths: [LOCKFILE],
        why: `the locked oxlint version changed (${before ?? 'none'} to ${after ?? 'none'})`
      })
    }
  }
  return policies
}

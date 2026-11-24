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
const MAX_LINK_HOPS = 8
const MAX_NAMED = 3
const MAX_WHY_CHARS = 300

// The first few items, then a count of the rest.
function someOf(items) {
  const named = items.slice(0, MAX_NAMED).join(', ')
  return items.length > MAX_NAMED ? `${named} and ${items.length - MAX_NAMED} more` : named
}

function bounded(text) {
  return text.length > MAX_WHY_CHARS ? `${text.slice(0, MAX_WHY_CHARS)}…` : text
}

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

// JSON with //, # and /* */ comments and trailing commas, as oxlint reads a JSON config.
export function parseJsonc(text) {
  const withoutComments = outsideStrings(text, (char, index) => {
    if ((char === '/' && text[index + 1] === '/') || char === '#') {
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

// Where a link points, from the link's stored bytes, or why that cannot be known here. A `name/..` in the
// target is resolved by the file system after following `name`, which may itself be a link, so collapsing it
// as text could name the wrong file: such a target counts as unreadable.
async function linkTarget(link, sha, cwd) {
  const raw = await git(['cat-file', 'blob', sha], cwd)
  const segments = raw.split('/')
  if (
    segments.some(
      (segment, index) =>
        segment === '..' && index > 0 && !['', '.', '..'].includes(segments[index - 1])
    )
  ) {
    return { unreadable: `${link} points through a directory name and then '..'` }
  }
  const target = resolveFrom(link, raw)
  return target ? { target } : { unreadable: `${link} links outside the repository` }
}

// `file` with each symlinked directory on its way replaced by the link's target, recording each link as an input.
async function resolveDirectories(file, tree, cwd, hops) {
  let parts = file.split('/')
  for (let index = 0; index < parts.length - 1; index += 1) {
    const prefix = parts.slice(0, index + 1).join('/')
    const entry = tree.get(prefix)
    if (entry?.mode === SYMLINK_MODE) {
      if (hops.length >= MAX_LINK_HOPS) {
        return { unreadable: `${file} goes through more than ${MAX_LINK_HOPS} links` }
      }
      const { target, unreadable } = await linkTarget(prefix, entry.sha, cwd)
      const next = target && path.posix.normalize(`${target}/${parts.slice(index + 1).join('/')}`)
      if (!next || next.startsWith('../')) {
        return { unreadable: unreadable ?? `${prefix} links outside the repository` }
      }
      hops.push(prefix)
      parts = next.split('/')
      index = -1
    }
  }
  return { path: parts.join('/') }
}

// Where a path's content is stored, following symlinks by their exact bytes, in the file itself and in any
// directory on its way. Every link on the way is an input too, since changing one changes what the path reads.
async function followLinks(file, tree, cwd) {
  const hops = []
  let current = file
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop += 1) {
    const resolved = await resolveDirectories(current, tree, cwd, hops)
    if (resolved.unreadable) {
      return { hops, unreadable: resolved.unreadable }
    }
    if (resolved.path !== current) {
      hops.push(resolved.path)
      current = resolved.path
    }
    const entry = tree.get(current)
    if (!entry) {
      return { hops }
    }
    if (entry.mode !== SYMLINK_MODE) {
      return { hops, entry }
    }
    const { target, unreadable } = await linkTarget(current, entry.sha, cwd)
    if (!target) {
      return { hops, unreadable }
    }
    hops.push(target)
    current = target
  }
  return { hops, unreadable: `${file} goes through more than ${MAX_LINK_HOPS} links` }
}

// Every config at head, what each file in the policy graph depends on (link targets and extends targets), and
// the files whose inputs cannot be read. Like oxlint, a file's `extends` resolve from where it is opened, not
// from where a link stores it. Each file is read once, so a cycle ends.
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
    const { hops, entry, unreadable } = await followLinks(file, tree, cwd)
    let targets = []
    if (unreadable) {
      unknown.set(file, unreadable)
    } else if (!entry) {
      // Missing at head: nothing to follow, though a push that changed it is still a change.
    } else if (SCRIPT_CONFIG.test(file)) {
      unknown.set(file, `${file} is a script config whose inputs cannot be read`)
    } else {
      try {
        const config = parseJsonc(await git(['cat-file', 'blob', entry.sha], cwd))
        const entries = config.extends ?? []
        targets = (Array.isArray(entries) ? entries : [null]).map((target) =>
          typeof target === 'string' ? resolveFrom(file, target) : null
        )
        if (targets.includes(null)) {
          unknown.set(file, `${file} extends a path outside the repository or not a path`)
        }
        const pluginLists = [
          config,
          ...(Array.isArray(config.overrides) ? config.overrides : [])
        ].map((section) => section?.jsPlugins)
        if (pluginLists.some((plugins) => Array.isArray(plugins) && plugins.length > 0)) {
          unknown.set(file, `${file} loads JS plugins, whose imports cannot be followed`)
        }
      } catch {
        unknown.set(file, `${file} does not parse as JSON with comments`)
      }
    }
    edges.set(file, [...hops, ...targets.filter(Boolean)])
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
        why: bounded(`${file} ${VERB[status] ?? 'changed'}`)
      })
    }
  }
  const graph = await policyGraph(head, cwd)
  for (const config of graph.configs) {
    const { roots, opaque } = reachable(config, graph, changed)
    // Unreadable inputs stay visible next to known changes, so a known cause never hides an unknown one.
    const unreadable = opaque.map((file) => graph.unknown.get(file))
    const alsoUnreadable =
      unreadable.length > 0 ? `; ${unreadable.length} of its inputs cannot be read` : ''
    if (roots.length > 0) {
      const extended = graph.edges.get(config) ?? []
      const how = roots.every((root) => extended.includes(root)) ? 'extends' : 'depends on'
      policies.push({
        dir: configDir(config),
        paths: roots,
        unreadable,
        why: bounded(`${config} ${how} ${someOf(roots)}, which changed${alsoUnreadable}`)
      })
    } else if (unreadable.length > 0 && !direct.has(config)) {
      policies.push({
        dir: configDir(config),
        paths: [],
        unreadable,
        why: bounded(
          `${unreadable[0]}${unreadable.length > 1 ? ` (and ${unreadable.length - 1} more unreadable inputs)` : ''}, so its scope is linted on every push`
        )
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

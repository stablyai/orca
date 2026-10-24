import { createHash } from 'node:crypto'
import {
  normalizeRuntimePathForComparison,
  isRuntimePathAbsolute
} from '../../shared/cross-platform-path'
import { getRepoExecutionHostId, getRepoRoutingConnectionId } from '../../shared/execution-host'
import { resolveProjectHostSetupProjection } from '../../shared/project-catalog-canonical-projection'
import { getProjectHostSetupLookup } from '../../shared/project-host-setup-lookup'
import { toAiVaultProjectKey } from '../../shared/ai-vault-project-key'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import { sessionFileExecutionNamespace } from '../../shared/ai-vault-scope-cwd-match'
import { resolveAiVaultScopeRealPaths } from '../ai-vault/session-scope-real-paths'
import type { SessionSearchScopeCatalog } from './session-search-scope-catalog'
import { managedWorktreeDirectories } from './session-search-scope-paths'

// Half-open BINARY intervals, including exact roots separately from descendants.
type Interval = [low: string, high: string, owner: string | null, priority: number]
type Rule = {
  path: string
  owner: string | null
  workspace: boolean
  prior?: boolean
  namespace?: string
}
export type SessionSearchProjectOwnership = {
  projectKey: string
  fingerprint: string
  planes: Record<string, Interval[]>
  ranges: [string, string][]
}
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const key = (path: string) => normalizeRuntimePathForComparison(path).toWellFormed()
export function materializeSessionSearchOwnership(
  catalog: SessionSearchScopeCatalog | null
): Rule[] | null {
  if (!catalog) {
    return null
  }
  const projection = resolveProjectHostSetupProjection(
    catalog.repos,
    catalog.projects,
    catalog.projectHostSetups
  )
  const owners = getProjectHostSetupLookup(projection.setups)
  const rules: Rule[] = []
  const add = (
    path: string | undefined,
    owner: string | null,
    workspace = false,
    prior = false
  ) => {
    if (path && isRuntimePathAbsolute(path)) {
      rules.push({ path, owner, workspace, prior })
    }
  }
  const local = (host: string) => host === (catalog.executionHostId ?? 'local')
  for (const setup of projection.setups) {
    // Nested SSH is a separate filesystem even when its transport belongs to this runtime.
    const host = setup.connectionId
      ? `ssh:${encodeURIComponent(setup.connectionId)}`
      : (setup.executionHostId ?? setup.hostId)
    if (local(host)) {
      add(setup.path, toAiVaultProjectKey(setup.projectId, setup.repoId))
    }
  }
  for (const repo of catalog.repos) {
    const connectionId = getRepoRoutingConnectionId(repo)
    const host = connectionId
      ? `ssh:${encodeURIComponent(connectionId)}`
      : getRepoExecutionHostId(repo)
    if (!local(host)) {
      continue
    }
    const owner = toAiVaultProjectKey(owners.projectId({ repoId: repo.id, hostId: host }), repo.id)
    add(repo.path, owner)
    for (const path of managedWorktreeDirectories(repo, catalog.settings)) {
      add(path, owner)
    }
  }
  const retained: { rule: Rule; prior: readonly string[]; repoId: string }[] = []
  for (const [id, meta] of Object.entries(catalog.worktreeMeta)) {
    const parsed = splitWorktreeIdForFilesystem(id)
    if (!parsed) {
      continue
    }
    const owner = toAiVaultProjectKey(
      owners.projectId({
        ...meta,
        repoId: parsed.repoId,
        hostId: meta.hostId ?? catalog.executionHostId ?? 'local'
      }),
      parsed.repoId
    )
    const rule = { path: parsed.worktreePath, owner, workspace: true }
    rules.push(rule)
    retained.push({ rule, prior: meta.priorWorktreeIds ?? [], repoId: parsed.repoId })
  }
  for (const { rule, prior, repoId } of retained) {
    for (const id of prior) {
      const parsed = splitWorktreeIdForFilesystem(id)
      if (parsed?.repoId === repoId) {
        add(parsed.worktreePath, rule.owner, true, true)
      }
    }
  }
  return rules
}

export async function compileSessionSearchProjectOwnership(
  catalog: SessionSearchScopeCatalog,
  projectKey: string,
  input = materializeSessionSearchOwnership(catalog) ?? []
): Promise<SessionSearchProjectOwnership> {
  const rules = [...input]
  const pathByKey = new Map<string, string>()
  for (const rule of rules) {
    const normalized = key(rule.path)
    if (!pathByKey.has(normalized)) {
      pathByKey.set(normalized, rule.path)
    }
  }
  const aliases = await resolveAiVaultScopeRealPaths([...pathByKey.values()])
  const realByPath = new Map(aliases.links.map((link) => [key(link.scopePath), key(link.realPath)]))
  const groups = new Map<string, Rule[]>()
  for (const rule of rules) {
    const root = realByPath.get(key(rule.path)) ?? key(rule.path)
    const entries = groups.get(root) ?? []
    entries.push(rule)
    groups.set(root, entries)
  }
  rules.length = 0
  for (const [root, entries] of groups) {
    const current = entries.filter((rule) => !rule.prior)
    const active = current.length ? current : entries
    rules.push(...active)
    // Registered spellings share current occupancy; never resolve arbitrary session cwd.
    const workspace = active.some((rule) => rule.workspace)
    const owners = new Set(
      active.filter((rule) => rule.workspace === workspace).map((rule) => rule.owner)
    )
    const owner = owners.size === 1 ? owners.values().next().value! : null
    for (const path of new Set([root, ...entries.map((rule) => key(rule.path))])) {
      rules.push({ path, owner, workspace, namespace: 'native' })
    }
  }
  const planes = new Map<string, Map<string, { owner: string | null; priority: number }>>()
  const insert = (plane: string, path: string, rule: Rule, mounted = false) => {
    const root = key(path)
    const roots = planes.get(plane) ?? new Map()
    const priority =
      (root.split('/').filter(Boolean).length + (mounted ? 1 : 0)) * 2 + Number(rule.workspace)
    const prior = roots.get(root)
    if (!prior || prior.priority < priority) {
      roots.set(root, { owner: rule.owner, priority })
    } else if (prior.priority === priority && prior.owner !== rule.owner) {
      prior.owner = null
    }
    planes.set(plane, roots)
  }
  for (const rule of rules) {
    insert(rule.namespace ?? '', rule.path, rule)
    const wsl = parseWslUncPath(rule.path)
    if (!wsl) {
      continue
    }
    if (/^\/mnt\/[A-Za-z](?:\/|$)/.test(wsl.linuxPath)) {
      insert('mounted', toWindowsWslPath(wsl.linuxPath, wsl.distro), rule, true)
    } else {
      insert(`wsl:${wsl.distro.toLowerCase()}`, wsl.linuxPath, rule)
    }
  }
  const compiled = Object.fromEntries(
    [...planes].map(([plane, roots]) => [plane, intervals(roots)])
  )
  const ranges: [string, string][] = []
  for (const [plane, entries] of Object.entries(compiled)) {
    for (const [low, high, owner] of entries) {
      if (owner === projectKey && plane !== 'mounted') {
        ranges.push([low, high])
      }
    }
    if (plane === 'mounted' && entries.some((entry) => entry[2] === projectKey)) {
      ranges.push(['/mnt/', '/mnt0'])
    }
  }
  ranges.sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]))
  const union: [string, string][] = []
  for (const range of ranges) {
    const prior = union.at(-1)
    if (prior && compare(range[0], prior[1]) <= 0) {
      if (compare(range[1], prior[1]) > 0) {
        prior[1] = range[1]
      }
    } else {
      union.push([...range])
    }
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([compiled, aliases.links]))
    .digest('base64url')
  return { projectKey, fingerprint, planes: compiled, ranges: union }
}

function intervals(roots: Map<string, { owner: string | null; priority: number }>): Interval[] {
  const events: { at: string; end?: string; value?: Interval }[] = []
  for (const [root, { owner, priority }] of roots) {
    const prefix = root.endsWith('/') ? root : `${root}/`
    for (const [low, high] of [
      [root, `${root}\0`],
      [prefix, `${prefix.slice(0, -1)}0`]
    ]) {
      events.push({ at: low, end: high, value: [low, high, owner, priority] }, { at: high })
    }
  }
  events.sort(
    (a, b) => compare(a.at, b.at) || (a.end && b.end ? -compare(a.end, b.end) : a.end ? 1 : -1)
  )
  const stack: Interval[] = []
  const result: Interval[] = []
  let previous = ''
  for (const event of events) {
    const active = stack.at(-1)
    if (active && compare(previous, event.at) < 0) {
      result.push([previous, event.at, active[2], active[3]])
    }
    while (stack.length && compare(stack.at(-1)![1], event.at) <= 0) {
      stack.pop()
    }
    if (event.value) {
      stack.push(event.value)
    }
    previous = event.at
  }
  return result
}

/** Binary searches precompiled ownership, never the catalog, for each indexed candidate. */
export function sessionSearchProjectOwner(
  selection: SessionSearchProjectOwnership,
  cwd: string,
  filePath: string
): string | null {
  cwd = key(cwd)
  const find = (plane: string, value: string): Interval | undefined => {
    const entries = selection.planes[plane] ?? []
    let low = 0,
      high = entries.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (compare(entries[middle][0], value) <= 0) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    const found = entries[low - 1]
    return found && compare(value, found[1]) < 0 ? found : undefined
  }
  const candidates = [find('', cwd), find(sessionFileExecutionNamespace(filePath), cwd)]
  if (/^\/mnt\/[A-Za-z](?:\/|$)/.test(cwd)) {
    candidates.push(find('mounted', key(toWindowsWslPath(cwd, ''))))
  }
  let best: Interval | undefined
  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }
    if (!best || candidate[3] > best[3]) {
      best = candidate
    } else if (candidate[3] === best[3] && candidate[2] !== best[2]) {
      best = [best[0], best[1], null, best[3]]
    }
  }
  return best?.[2] ?? null
}

export function sessionSearchProjectOwns(
  selection: SessionSearchProjectOwnership,
  cwd: string,
  filePath: string
): boolean {
  return sessionSearchProjectOwner(selection, cwd, filePath) === selection.projectKey
}

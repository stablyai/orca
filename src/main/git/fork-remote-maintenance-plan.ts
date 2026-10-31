import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { constructGitRemotePolicies } from '../../shared/git-config-snapshot-runner'
import { stockFetchCoverage, type GitRefFact } from '../../shared/git-branch-cleanup-fetch'
import {
  acquireForkView,
  sameForkRepository,
  forkRepositoryKey,
  buildNarrowForkFetchRefspec,
  type GitExecFn
} from './fork-remote-policy'
import { collectForkDependencies } from './fork-remote-dependencies'

export type MaintenanceOptions = {
  mode: 'remove' | 'migrate'
  names?: ReadonlyMap<string, string>
  scope?: string
  existingBranchesOnly?: boolean
  read: () =>
    | Promise<{ metadata: readonly WorktreeMeta[]; select?: (name: string) => boolean }>
    | { metadata: readonly WorktreeMeta[]; select?: (name: string) => boolean }
}

export async function planForkMaintenance(
  exec: GitExecFn,
  path: string,
  options: MaintenanceOptions
) {
  const view = await acquireForkView(exec, path, options.scope)
  const consumers = await options.read()
  const { urls, policy } = view
  const eligible = new Map<
    string,
    { old: NonNullable<ReturnType<typeof stockFetchCoverage>>; footprint: GitRefFact[] }
  >()
  for (const [name, url] of options.names ?? urls) {
    const fields = policy.get(name)
    const specs = fields?.get('fetch') ?? []
    if (
      !fields ||
      name === 'origin' ||
      name === 'upstream' ||
      (consumers.select && !consumers.select(name)) ||
      !sameForkRepository(url, urls.get(name) ?? '') ||
      [...fields].some(
        ([key, values]) =>
          !['url', 'fetch', 'orca-created', 'tagopt'].includes(key) ||
          JSON.stringify(values) !== JSON.stringify(view.local.get(`remote.${name}.${key}`))
      ) ||
      fields.get('url')?.length !== 1 ||
      fields.get('orca-created')?.length !== 1 ||
      !view.localBooleans.get(`remote.${name}.orca-created`) ||
      !view.booleans.get(`remote.${name}.orca-created`) ||
      (fields.get('tagopt')?.length ?? 0) > 1 ||
      fields.get('tagopt')?.some((value) => value !== '--no-tags') ||
      view.pushes.get(name)?.some((value) => !sameForkRepository(value, urls.get(name) ?? ''))
    ) {
      continue
    }
    if (
      view.contexts.some(
        (context) =>
          context.legacy.has(name) ||
          JSON.stringify([...(context.policy.get(name) ?? [])]) !== JSON.stringify([...fields]) ||
          !sameForkRepository(url, context.urls.get(name) ?? '') ||
          context.pushes.get(name)?.some((value) => !sameForkRepository(value, url))
      )
    ) {
      continue
    }
    const old = stockFetchCoverage(name, specs)
    if (!old || !view.proof.exclusive(name, `refs/remotes/${name}/`)) {
      continue
    }
    const base = `refs/remotes/${name}/`
    const namespace = old.specs.length ? view.proof.refDomain(`${base}*`) : []
    if (
      namespace.some(
        (row) =>
          !row.ref.startsWith(base) ||
          (row.symref && !(row.ref === `${base}HEAD` && row.symref.startsWith(base)))
      )
    ) {
      continue
    }
    eligible.set(name, {
      old,
      footprint: namespace.filter((row) => old.covers(row.ref.slice(base.length)))
    })
  }
  if (!eligible.size || view.lifetimeUncertain) {
    return { view, consumers, actions: [] }
  }
  const { obligations, unknown, unresolved, pinDomain } = collectForkDependencies(view, consumers)
  const actions: { name: string; desired?: string[]; prune: GitRefFact[] }[] = []
  let prospective: ReturnType<typeof constructGitRemotePolicies>[] | undefined
  for (const [name, { old, footprint }] of eligible) {
    const keys = new Set(
      [...(policy.get(name)?.get('url') ?? []), urls.get(name)!].map(
        (url) => `url:${forkRepositoryKey(url) ?? url}`
      )
    )
    const deps = [
      obligations.get(`name:${name}`),
      ...[...keys].map((key) => obligations.get(key))
    ].filter((value): value is { all: boolean; sources: Set<string> } => Boolean(value))
    if (unknown || unresolved || deps.some((dep) => dep.all)) {
      continue
    }
    const base = `refs/remotes/${name}/`
    // Unmapped and absent pins preserve the alias without granting deletion authority.
    const namespacePins = pinDomain(`${base}*`, options.mode === 'remove' || !old.specs.length)
    if (options.mode === 'remove') {
      if (deps.length || namespacePins.length) {
        continue
      }
      prospective ??= view.contexts.map((context) =>
        constructGitRemotePolicies(
          new Map([...context.config].filter(([key]) => !key.startsWith('remote.'))),
          context.stores
        )
      )
      const survives = prospective.some(
        (policy) => policy.names.has(name) || policy.uncertain.has(name) || policy.observe.has(name)
      )
      if (!survives) {
        actions.push({ name, prune: [] })
      }
      continue
    }
    if (
      namespacePins.some(
        (row) => !row.ref.startsWith(base) || !old.covers(row.ref.slice(base.length))
      )
    ) {
      continue
    }
    const matchedPins = new Set(namespacePins.map((row) => row.ref))
    const sources = new Set(deps.flatMap((dep) => [...dep.sources]))
    for (const pin of matchedPins) {
      sources.add(pin.slice(base.length))
    }
    const desiredSpecs: string[] = []
    for (const branch of sources) {
      if (old.contains(branch)) {
        desiredSpecs.push(buildNarrowForkFetchRefspec(name, branch))
      } else if (old.covers(branch)) {
        desiredSpecs.push(`+refs/heads/${branch}:${base}${branch}`)
      }
    }
    const desiredCoverage = stockFetchCoverage(name, desiredSpecs)!
    if (desiredCoverage.signature === old.signature) {
      continue
    }
    const desired = desiredCoverage.specs
    const prune = footprint.filter(
      (row) =>
        !row.symref &&
        !row.ref.endsWith('/HEAD') &&
        !matchedPins.has(row.ref) &&
        !desiredCoverage.covers(row.ref.slice(base.length))
    )
    actions.push({ name, desired, prune })
  }
  return { view, consumers, actions }
}

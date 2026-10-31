import { indexGitRefs } from '../../shared/git-branch-cleanup-fetch'
import { forkRepositoryKey, type ForkView } from './fork-remote-policy'
import type { MaintenanceOptions } from './fork-remote-maintenance-plan'

export function collectForkDependencies(
  view: ForkView,
  consumers: Awaited<ReturnType<MaintenanceOptions['read']>>
) {
  const { policy, urls, refs } = view

  type Obligation = { all: boolean; sources: Set<string> }
  const known = new Set(
    [
      ...view.names,
      ...[...policy.values()].flatMap((fields) => [
        ...(fields.get('url') ?? []),
        ...(fields.get('pushurl') ?? [])
      ]),
      ...urls.values(),
      ...[...view.pushes.values()].flat()
    ].map((value) => forkRepositoryKey(value) ?? value)
  )
  let unresolved = false
  const obligations = new Map<string, Obligation>()
  const pins = new Set<string>()
  const bases = new Set<string>()
  const keyFor = (value: string) =>
    view.names.has(value) ? `name:${value}` : `url:${forkRepositoryKey(value) ?? value}`
  const retain = (value: string, source?: string) => {
    if (!value) {
      return
    }
    if (value === '.') {
      if (source) {
        bases.add(source)
      }
      return
    }
    if (!known.has(forkRepositoryKey(value) ?? value) && !forkRepositoryKey(value)) {
      unresolved = true
    }
    const key = keyFor(value)
    const dep = obligations.get(key) ?? { all: false, sources: new Set<string>() }
    if (source?.startsWith('refs/heads/')) {
      dep.sources.add(source.slice(11))
    } else {
      dep.all = true
    }
    obligations.set(key, dep)
  }
  for (const row of [...refs, ...view.native]) {
    if (
      row.symref &&
      !(
        row.ref.endsWith('/HEAD') &&
        row.ref.startsWith('refs/remotes/') &&
        row.symref.startsWith(row.ref.slice(0, -4))
      )
    ) {
      bases.add(row.symref)
    }
    if (row.upstream) {
      bases.add(row.upstream)
    }
    if (row.remote) {
      retain(row.remote, row.source)
    }
  }
  for (const saved of view.dependencyConfigs) {
    for (const [key, values] of saved) {
      if (key === 'remote.pushdefault') {
        for (const value of values) {
          retain(value)
        }
      }
      const match = /^branch\.(.+)\.(remote|pushremote|base)$/.exec(key)
      if (!match) {
        continue
      }
      const merges = saved.get(`branch.${match[1]}.merge`) ?? []
      for (const value of values) {
        if (match[2] === 'base') {
          bases.add(value)
        } else if (
          (match[2] === 'pushremote' && saved.get(`branch.${match[1]}.remote`)?.at(-1) !== value) ||
          merges.length !== 1
        ) {
          retain(value)
          if (value === '.') {
            merges.forEach((ref) => bases.add(ref))
          }
        } else {
          retain(value, merges[0])
        }
      }
    }
  }
  for (const meta of consumers.metadata) {
    if (meta.pushTarget) {
      if (view.names.has(meta.pushTarget.remoteName) || !meta.pushTarget.remoteUrl) {
        retain(meta.pushTarget.remoteName, `refs/heads/${meta.pushTarget.branchName}`)
      }
      if (meta.pushTarget.remoteUrl) {
        retain(meta.pushTarget.remoteUrl, `refs/heads/${meta.pushTarget.branchName}`)
      }
    }
    for (const base of [meta.baseRef, meta.sparseBaseRef]) {
      if (base) {
        bases.add(base)
      }
    }
  }
  const refNames = new Map(refs.map((row) => [row.ref, row]))
  let unknown = false
  for (const base of bases) {
    const possibilities = base.startsWith('refs/')
      ? [base]
      : [
          base,
          `refs/${base}`,
          `refs/tags/${base}`,
          `refs/heads/${base}`,
          `refs/remotes/${base}`,
          `refs/remotes/${base}/HEAD`
        ]
    const existing = possibilities.filter((ref) => refNames.has(ref))
    for (const ref of new Set([
      ...existing,
      ...possibilities.filter((ref) => ref.startsWith('refs/remotes/') || base.startsWith('refs/'))
    ])) {
      if (!ref.startsWith('refs/heads/')) {
        pins.add(ref)
        const target = refNames.get(ref)?.symref
        if (target) {
          pins.add(target)
        }
      }
    }
    if (!base.startsWith('refs/') && !existing.length && !base.includes('/')) {
      unknown = true
    }
  }
  const pinDomain = indexGitRefs([...pins].map((ref) => ({ ref, oid: '', symref: '' })))
  return { obligations, unknown, unresolved, pinDomain }
}

import type { GitPushTarget } from '../../shared/worktree/types'
import {
  resolveFetchTrackingRef,
  createFetchEffectProof
} from '../../shared/git-branch-cleanup-fetch'
import {
  getRemoteFetchRefspecs,
  acquireForkView,
  currentBranch,
  sameForkRepository,
  buildNarrowForkFetchRefspec,
  wildcardForkFetchRefspec,
  isAddCollision,
  forkDestination,
  type ForkBranchOperation,
  type GitExecFn
} from './fork-remote-policy'

/** Checked stages have one lock-held setup composition; raw writers stay private. */
export async function selectForkBranchUnderLock(
  exec: GitExecFn,
  path: string,
  target: GitPushTarget,
  scope: string,
  configure: boolean,
  preferred: string,
  branch?: string
): Promise<ForkBranchOperation> {
  const forkUrl = target.remoteUrl
  if (!forkUrl) {
    const source = `refs/heads/${target.branchName}`
    const destination = branch
      ? resolveFetchTrackingRef(await getRemoteFetchRefspecs(exec, path, target.remoteName), source)
      : undefined
    if (branch && !destination) {
      throw new Error(`No tracking mapping for ${target.remoteName}/${target.branchName}.`)
    }
    return { target, source, destination, localBranch: branch, branch, scope, added: false }
  }
  let view = await acquireForkView(exec, path, scope, forkUrl)
  const localBranch = branch ?? (configure ? currentBranch(view) : undefined)
  const source = `refs/heads/${target.branchName}`
  let selected: GitPushTarget | undefined
  let added = false
  for (const name of new Set([
    preferred,
    target.remoteName,
    ...[...view.urls.keys()].filter((name) => !view.legacy.has(name)),
    ...[...view.legacy].sort()
  ])) {
    const url = view.urls.get(name)
    const endpoints = view.pushes.get(name) ?? []
    if (
      !url ||
      !sameForkRepository(url, view.intended!.url!) ||
      !endpoints.length ||
      endpoints.some(
        (value) => !view.intended!.pushes.some((intended) => sameForkRepository(value, intended))
      ) ||
      view.booleans.get(`remote.${name}.mirror`)
    ) {
      continue
    }
    const specs = view.policy.get(name)?.get('fetch') ?? []
    const existing = resolveFetchTrackingRef(specs, source)
    const proposed = buildNarrowForkFetchRefspec(name, target.branchName)
    const next = existing ? specs : [...specs, proposed]
    const destination = resolveFetchTrackingRef(next, source)
    if (
      !destination ||
      !view.proof.safe(url, existing ? `+${source}:${destination}` : proposed, !existing) ||
      !view.proof.unambiguous(name, source, destination) ||
      !view.proof.operation(url, next, source, 'push', view.booleans.get('push.followtags')) ||
      !view.proof.operation(
        url,
        next,
        source,
        'pull',
        view.config.get(`remote.${name}.tagopt`)?.at(-1) !== '--no-tags'
      )
    ) {
      continue
    }
    if (!existing) {
      await exec(['config', '--add', `remote.${name}.fetch`, proposed], path)
      const fields = view.policy.get(name) ?? new Map<string, string[]>()
      fields.set('fetch', next)
      view.policy.set(name, fields)
      view.config.set(`remote.${name}.fetch`, next)
      view.mappings.push({ name, spec: proposed, url })
      view.proof = createFetchEffectProof(view.mappings, view.refs, sameForkRepository)
    }
    selected = { ...target, remoteName: name }
    break
  }
  if (!selected) {
    for (let suffix = 1; suffix < 100; suffix += 1) {
      const name = suffix === 1 ? target.remoteName : `${target.remoteName}-${suffix}`
      if (
        view.names.has(name) ||
        view.proof.refDomain(`refs/remotes/${name}/*`).length ||
        !view.proof.safe(view.intended!.url!, wildcardForkFetchRefspec(name), true) ||
        !view.proof.unambiguous(name, source, `refs/remotes/${name}/${target.branchName}`)
      ) {
        continue
      }
      try {
        await exec(
          ['remote', 'add', '-t', `${target.branchName}*`, '--no-tags', name, forkUrl],
          path
        )
      } catch (error) {
        if (!isAddCollision(error, name)) {
          throw error
        }
        view = await acquireForkView(exec, path, scope, forkUrl)
        view.names.add(name)
        continue
      }
      await exec(['config', '--local', `remote.${name}.orca-created`, 'true'], path)
      const spec = buildNarrowForkFetchRefspec(name, target.branchName)
      view.names.add(name)
      view.urls.set(name, view.intended!.url!)
      view.pushes.set(name, view.intended!.pushes)
      view.policy.set(name, new Map([['fetch', [spec]]]))
      view.mappings.push({ name, spec, url: view.intended!.url! })
      view.proof = createFetchEffectProof(view.mappings, view.refs, sameForkRepository)
      selected = { ...target, remoteName: name }
      added = true
      break
    }
  }
  if (!selected) {
    throw new Error(`Could not find an available remote name for ${target.remoteName}.`)
  }
  return {
    target: selected,
    source,
    destination: forkDestination(view, selected),
    view,
    localBranch,
    branch,
    scope,
    added
  }
}

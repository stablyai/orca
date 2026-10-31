import type { GitPushTarget } from '../../shared/worktree/types'
import {
  withForkRemoteLock,
  acquireForkView,
  forkDestination,
  type GitExecFn
} from './fork-remote-policy'
import { planForkMaintenance, type MaintenanceOptions } from './fork-remote-maintenance-plan'
export {
  buildNarrowForkFetchRefspec,
  wildcardForkFetchRefspec,
  sameForkRepository,
  withForkRemoteLock,
  remoteHasOrcaProvenance,
  getRemoteFetchRefspecs,
  type GitExecFn
} from './fork-remote-policy'
export { selectForkBranchUnderLock } from './fork-remote-branch-selection'
export {
  acquireForkBranchUnderLock,
  configureForkCallerUnderLock,
  fetchForkBranch
} from './fork-remote-branch-acquisition'

export async function runForkNativeAction<T>(
  exec: GitExecFn,
  path: string,
  target: GitPushTarget,
  kind: 'push' | 'pull',
  run: () => Promise<T>,
  scope = ''
): Promise<T> {
  return withForkRemoteLock(
    exec,
    path,
    async () => {
      const view = await acquireForkView(exec, path, scope, target.remoteUrl)
      forkDestination(view, target)
      const specs = view.policy.get(target.remoteName)?.get('fetch') ?? []
      if (
        !view.proof.operation(
          view.urls.get(target.remoteName)!,
          specs,
          `refs/heads/${target.branchName}`,
          kind,
          kind === 'push'
            ? view.booleans.get('push.followtags')
            : view.config.get(`remote.${target.remoteName}.tagopt`)?.at(-1) !== '--no-tags'
        )
      ) {
        throw new Error('Fork tracking conflicts with another Git reference.')
      }
      return run()
    },
    scope
  )
}

export async function maintainForkRemotes(
  exec: GitExecFn,
  path: string,
  options: MaintenanceOptions
): Promise<string[]> {
  return withForkRemoteLock(
    exec,
    path,
    async () => {
      const plan = () => planForkMaintenance(exec, path, options)
      const initial = await plan()
      if (!initial.actions.length) {
        return []
      }
      const fresh = await plan()
      if (
        initial.view.fingerprint !== fresh.view.fingerprint ||
        JSON.stringify(initial.consumers) !== JSON.stringify(fresh.consumers) ||
        JSON.stringify(initial.actions) !== JSON.stringify(fresh.actions)
      ) {
        return []
      }
      const affected: string[] = []
      for (const action of fresh.actions) {
        if (!action.desired) {
          await exec(['remote', 'remove', action.name], path)
        } else {
          const key = `remote.${action.name}.fetch`
          const installed = new Set(fresh.view.config.get(key) ?? [])
          const desired = new Set(action.desired)
          for (const spec of desired) {
            if (!installed.has(spec)) {
              await exec(['config', '--add', key, spec], path)
            }
          }
          for (const row of action.prune) {
            await exec(['update-ref', '--no-deref', '-d', row.ref, row.oid], path).catch(() => {})
          }
          for (const spec of installed) {
            if (!desired.has(spec)) {
              const pattern = `^${spec.replace(/[\\.[\](){}*+?^$|]/g, '\\$&')}$`
              await exec(['config', '--unset-all', key, pattern], path)
            }
          }
          await exec(['config', `remote.${action.name}.tagOpt`, '--no-tags'], path)
        }
        affected.push(action.name)
      }
      return affected
    },
    options.scope
  ).catch(() => [])
}

import { posix } from 'node:path'
import { normalizeRuntimePathForComparison as selectionKey } from '../../shared/cross-platform-path'
import { getRepoExecutionHostId, toRuntimeExecutionHostId } from '../../shared/execution-host'
import type {
  NestedRepoScanResult,
  ProjectGroupImportMode,
  ProjectGroupImportResult
} from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { sameWslDistroName } from '../../shared/windows-path-access'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  admitRepositoryCheckout,
  type RepositoryCheckoutAdmission
} from '../repository-checkout-admission'
import { resolveNestedRepoSelection } from '../project-groups/nested-repo-import'
import { createNestedRepoImportTargetResolver } from '../project-groups/nested-repo-import-target'
import {
  ensureNewWslOwner,
  wslMutationAuthority,
  wslProjectRoutingEnabled,
  type PlacementCaller,
  type PlacementStore
} from './project-placement'
import {
  IncompleteWslProject,
  listWslOwnerRepos,
  registerOnWslOwner
} from './wsl-project-registration'
import { groupOnWslOwner, type PlacedNestedItem } from './wsl-nested-project-grouping'

type ImportItem = ProjectGroupImportResult['projects'][number]

/** Each selection is placed once; grouping consumes those placements and never re-derives them. */
type NestedImportPlacement =
  | { kind: 'ordinary' }
  | { kind: 'saved-windows'; savedRow: (path: string) => Repo }
  | { kind: 'done'; result: ProjectGroupImportResult }

function linuxPathKey(path: string): string {
  return posix.normalize(path).replace(/\/+$/, '')
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export async function placeNestedImport(
  store: PlacementStore,
  args: {
    parentPath: string
    projectPaths: string[]
    groupName?: string
    mode: ProjectGroupImportMode
    connectionId?: string | null
  },
  caller: PlacementCaller,
  scan: NestedRepoScanResult
): Promise<NestedImportPlacement> {
  const parent = parseWslUncPath(args.parentPath)
  if (args.connectionId || !parent || !wslProjectRoutingEnabled(store, caller.domain)) {
    return { kind: 'ordinary' }
  }
  const selection = resolveNestedRepoSelection({ scan, projectPaths: args.projectPaths })
  const targetResolver = createNestedRepoImportTargetResolver()
  const results = new Map<string, ImportItem>()
  const items: (PlacedNestedItem & {
    linuxPath: string
    admission: RepositoryCheckoutAdmission
  })[] = []
  for (const [order, path] of selection.selectedPaths.entries()) {
    try {
      const target = await targetResolver.resolveLocal(path)
      const admission = await admitRepositoryCheckout(store, target, 'git', {
        scope: 'wsl',
        domain: caller.domain,
        aliases: 'lexical'
      })
      const owner = parseWslUncPath(admission.registrationPath)
      const original = parseWslUncPath(path)
      if (!owner || !original || !sameWslDistroName(owner.distro, parent.distro)) {
        throw new Error('Selected projects must belong to the selected WSL distro.')
      }
      items.push({
        path,
        order,
        selectedLinuxPath: original.linuxPath,
        linuxPath: owner.linuxPath,
        admission
      })
    } catch (error) {
      results.set(selectionKey(path), {
        path,
        status: 'failed',
        error: errorText(error, 'Repository could not be inspected')
      })
    }
  }
  // An uninspectable selection has no proven Windows claim; never send it to Windows grouping.
  const allSaved = () => results.size === 0 && items.every((item) => item.admission.findSaved())
  const savedWindows = (): NestedImportPlacement => ({
    kind: 'saved-windows',
    savedRow: (path) => {
      const row = items.find((item) => item.path === path)?.admission.findSaved()
      if (!row) {
        throw new Error('This project changed while it was being imported.')
      }
      return row
    }
  })
  const refuseMixedGroup = () => {
    if (args.mode === 'group' && items.some((item) => item.admission.findSaved())) {
      throw new Error(
        'Some of these projects are already saved on Windows. Import them separately instead of as a group.'
      )
    }
  }
  if (allSaved()) {
    return savedWindows()
  }
  refuseMixedGroup()
  const environmentId = await ensureNewWslOwner(store, parent.distro, caller)
  if (allSaved()) {
    return savedWindows()
  }
  refuseMixedGroup()
  const executionHostId = toRuntimeExecutionHostId(environmentId)
  const knownIds = new Set((await listWslOwnerRepos(environmentId)).map((repo) => repo.id))
  const registered = new Map<string, ImportItem>()
  for (const { path, linuxPath, admission } of items) {
    const key = linuxPathKey(linuxPath)
    let result: ImportItem
    try {
      const saved = admission.findSaved()
      const previous = registered.get(key)
      const receipt = saved
        ? { kind: 'saved' as const, repo: saved }
        : previous
          ? null
          : await registerOnWslOwner(
              wslMutationAuthority(store, caller, environmentId, admission.findSaved),
              { kind: 'add', path: linuxPath, repoKind: 'git' }
            )
      if (receipt?.kind === 'saved') {
        result = {
          path,
          projectId: receipt.repo.id,
          executionHostId: getRepoExecutionHostId(receipt.repo),
          status: args.mode === 'group' ? 'failed' : 'already-known',
          ...(args.mode === 'group'
            ? {
                error: 'This project is already saved on Windows, so it was not added to the group.'
              }
            : {})
        }
      } else if (previous) {
        result = {
          ...previous,
          path,
          status: previous.status === 'imported' ? 'already-known' : previous.status
        }
      } else if (receipt) {
        result = {
          path,
          projectId: receipt.repo.id,
          status: knownIds.has(receipt.repo.id) ? 'already-known' : 'imported',
          executionHostId
        }
        knownIds.add(receipt.repo.id)
      } else {
        throw new Error('The project registration returned no receipt.')
      }
    } catch (error) {
      // An acknowledged row remains useful even when later preparation or transport fails.
      const repo =
        error instanceof IncompleteWslProject
          ? error.repo
          : (await listWslOwnerRepos(environmentId).catch(() => [])).find(
              (row) => linuxPathKey(row.path) === key
            )
      result = {
        path,
        projectId: repo?.id,
        status: 'failed',
        executionHostId,
        error: errorText(error, 'Repository could not be prepared')
      }
    }
    registered.set(key, result)
    results.set(selectionKey(path), result)
  }
  for (const failed of results.values()) {
    if (failed.status !== 'failed' || !failed.projectId) {
      continue
    }
    for (const [key, result] of results) {
      if (
        result.projectId === failed.projectId &&
        result.executionHostId === failed.executionHostId &&
        result.status !== 'failed'
      ) {
        results.set(key, { ...result, status: 'failed', error: failed.error })
      }
    }
  }
  const group =
    args.mode === 'group'
      ? await groupOnWslOwner({
          authority: wslMutationAuthority(store, caller, environmentId, () => {
            if (
              items.some((item) => item.admission.findSaved()) ||
              [...results.values()].some(
                (result) => result.projectId && result.executionHostId !== executionHostId
              )
            ) {
              throw new Error(
                'Some of these projects are already saved on Windows. Import them separately instead of as a group.'
              )
            }
            return undefined
          }),
          parentLinuxPath: parent.linuxPath,
          groupName: args.groupName?.trim() || posix.basename(parent.linuxPath) || parent.distro,
          items,
          results
        })
      : undefined
  const seen = new Set<string>()
  const projects = args.projectPaths.flatMap((path) => {
    if (seen.has(selectionKey(path))) {
      return []
    }
    seen.add(selectionKey(path))
    const result = results.get(selectionKey(path))
    if (result) {
      return [{ ...result, path }]
    }
    return selection.rejectedPaths.includes(path)
      ? [
          {
            path,
            status: 'failed' as const,
            error: 'Repository was not found in the nested repo scan result'
          }
        ]
      : []
  })
  return {
    kind: 'done',
    result: {
      executionHostId,
      ...(group ? { group: { ...group, executionHostId } } : {}),
      projects,
      importedCount: projects.filter((row) => row.status === 'imported').length,
      alreadyKnownCount: projects.filter((row) => row.status === 'already-known').length,
      failedCount: projects.filter((row) => row.status === 'failed').length
    }
  }
}

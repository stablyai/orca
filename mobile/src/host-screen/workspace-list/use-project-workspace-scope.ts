import { useMemo } from 'react'
import {
  getRepoHostIdentity,
  getRepoHostIdentityForParts
} from '../../../../src/shared/repository/repo-host-identity'
import { resolveWorktreeHostId } from '../../worktree/row-presentation/worktree-host-context-labels'
import { readFeedPairedServerRow } from '../../../../src/shared/sidebar-list/feed/sidebar-feed-worktrees'
import type { HostListSectionsInputs } from './use-host-list-sections'

export function useProjectWorkspaceScope(inputs: HostListSectionsInputs) {
  const { state, feed, displayWorktrees } = inputs
  const repos = useMemo(
    () => [
      ...state.desktopRepos,
      ...(state.servedProjectSections?.repos ?? []),
      ...(feed?.kind === 'ready' ? (feed.domains.projectCatalog?.repos ?? []) : [])
    ],
    [state.desktopRepos, state.servedProjectSections, feed]
  )
  const scope = useMemo(() => {
    const chatKeys = new Set(repos.filter((repo) => repo.chatWorkspace).map(getRepoHostIdentity))
    const hiddenChatKeys = new Set(
      repos
        .filter((repo) => repo.chatWorkspace && repo.hiddenAt !== undefined)
        .map(getRepoHostIdentity)
    )
    const projectRow = (row: { repoId: string; hostId?: string | null }) =>
      !chatKeys.has(getRepoHostIdentityForParts(row.repoId, row.hostId ?? 'local'))
    return { chatKeys, hiddenChatKeys, projectRow }
  }, [repos])
  const scopedRows = useMemo(
    () =>
      scope.chatKeys.size
        ? displayWorktrees.filter((row) =>
            scope.projectRow({
              repoId: row.repoId,
              hostId: resolveWorktreeHostId(row, state.repoHostIdByRepoId)
            })
          )
        : displayWorktrees,
    [scope, displayWorktrees, state.repoHostIdByRepoId]
  )
  const scopedState = useMemo(
    () =>
      scope.chatKeys.size
        ? {
            ...state,
            desktopRepos: state.desktopRepos.filter(
              (repo) => !scope.chatKeys.has(getRepoHostIdentity(repo))
            ),
            servedProjectSections: state.servedProjectSections
              ? {
                  ...state.servedProjectSections,
                  repos: state.servedProjectSections.repos.filter(
                    (repo) => !scope.chatKeys.has(getRepoHostIdentity(repo))
                  )
                }
              : null
          }
        : state,
    [scope, state]
  )
  const scopedFeed = useMemo(() => {
    if (!scope.chatKeys.size || feed?.kind !== 'ready') {
      return feed
    }
    const domains = feed.domains
    return {
      ...feed,
      domains: {
        ...domains,
        workspaces: new Map([...domains.workspaces].filter(([, row]) => scope.projectRow(row))),
        pairedServerRows: new Map(
          [...domains.pairedServerRows].filter(([, row]) => {
            const workspace = readFeedPairedServerRow(row)?.worktree
            return !workspace || scope.projectRow(workspace)
          })
        ),
        projectCatalog: domains.projectCatalog
          ? {
              ...domains.projectCatalog,
              repos: domains.projectCatalog.repos.filter(
                (repo) => !scope.chatKeys.has(getRepoHostIdentity(repo))
              )
            }
          : null
      }
    }
  }, [scope, feed])
  const chatRepos = useMemo(
    () => [
      ...new Map(
        repos
          .filter((repo) => repo.chatWorkspace && repo.hiddenAt === undefined)
          .map((repo) => [getRepoHostIdentity(repo), repo])
      ).values()
    ],
    [repos]
  )
  const chatRows = useMemo(
    () =>
      scope.chatKeys.size
        ? displayWorktrees.filter((row) => {
            const hostId = resolveWorktreeHostId(row, state.repoHostIdByRepoId)
            return (
              !scope.projectRow({ repoId: row.repoId, hostId }) &&
              !scope.hiddenChatKeys.has(getRepoHostIdentityForParts(row.repoId, hostId ?? 'local'))
            )
          })
        : [],
    [scope, displayWorktrees, state.repoHostIdByRepoId]
  )
  return {
    projects: { ...inputs, displayWorktrees: scopedRows, state: scopedState, feed: scopedFeed },
    chatRepos,
    chatRows
  }
}

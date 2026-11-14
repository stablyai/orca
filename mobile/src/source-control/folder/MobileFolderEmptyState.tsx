import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { ActivityIndicator, ScrollView, View } from 'react-native'
import { FolderGit2, GitBranch, Plus } from 'lucide-react-native'
import type { Repo } from '../../../../src/shared/repo-types'
import { projectGroupIdFromRepoId } from '../../../../src/shared/folder-workspaces/folder-workspace-worktree'
import { getRepoExecutionHostId } from '../../../../src/shared/execution-host'
import { WORKTREE_CREATE_EXACT_NAME_RUNTIME_CAPABILITY } from '../../../../src/shared/worktree-runtime-capabilities'
import { ListGroup, ListRow, SectionHeader } from '../../components/list/ListGroup'
import { MobileStateView } from '../../components/MobileStateView'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useHostQuery } from '../../query/host-query'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  scopeRpcClientToExecutionHost,
  workspaceRouteExecutionHost
} from '../../worktree/execution-hosts/execution-host-scoped-rpc-client'
import type { FolderListRow } from './mobile-folder-attached-worktrees'
import {
  isFolderRepoCreateBusy,
  subscribeFolderRepoCreates,
  type FolderRepoTarget
} from './folder-repo-worktree-create'
import {
  folderSourceCatalogQuery,
  selectFolderSourceRepos,
  serverFolderSourceCatalogQuery
} from './folder-source-repos-query'

const NO_INPUT = {}

type Props = {
  hostId: string
  folder: FolderListRow
  /** The paired desktop's capabilities. */
  desktopCapabilities: readonly string[]
  /** The capabilities of the host the folder lives on: the desktop's, or its server's. */
  folderHostCapabilities: readonly string[]
  /** On screen and on top; the repository read waits for it. */
  observing: boolean
  /** The header's refresh reads the repositories too. */
  refreshers: Set<() => void>
  onCreate: (repo: Repo, target: FolderRepoTarget, client: RpcClient, name: string) => void
  bottomInset: number
}

/** A folder with no attached worktrees: desktop's copy, then one create card per repository. */
export function MobileFolderEmptyState(props: Props) {
  const { hostId, folder, desktopCapabilities, folderHostCapabilities, observing, refreshers } =
    props
  const t = useMobileTranslation()
  const { client: desktopClient, state } = useHostClient(hostId)
  // A relayed server's folder is created on that server, through the desktop.
  const routeHost = workspaceRouteExecutionHost(desktopClient, desktopCapabilities, folder.hostId)
  const server = routeHost?.startsWith('runtime:') ? routeHost : undefined
  // Only exact-name creates land as named; a server's rows also need a desktop new enough to relay its folder lineage.
  const canCreate =
    state === 'connected' &&
    routeHost !== null &&
    folderHostCapabilities.includes(WORKTREE_CREATE_EXACT_NAME_RUNTIME_CAPABILITY) &&
    (!server || desktopCapabilities.includes(WORKTREE_CREATE_EXACT_NAME_RUNTIME_CAPABILITY))
  const createClient = useMemo(
    () =>
      desktopClient && server
        ? scopeRpcClientToExecutionHost(desktopClient, server)
        : desktopClient,
    [desktopClient, server]
  )
  const catalog = useHostQuery(
    server ? serverFolderSourceCatalogQuery : folderSourceCatalogQuery,
    { hostId, client: canCreate ? createClient : null },
    { exec: server ?? 'local' },
    NO_INPUT,
    { enabled: canCreate, subscribed: observing }
  )
  const refetchCatalog = catalog.refetch
  useEffect(() => {
    if (!canCreate) {
      return
    }
    const refresh = () => void refetchCatalog()
    refreshers.add(refresh)
    return () => {
      refreshers.delete(refresh)
    }
  }, [canCreate, refetchCatalog, refreshers])
  const repos = useMemo(
    () =>
      canCreate
        ? selectFolderSourceRepos(catalog.data, projectGroupIdFromRepoId(folder.repoId))
        : [],
    [canCreate, catalog.data, folder.repoId]
  )
  const name = folder.displayName.trim()
  const catalogFailed = canCreate && catalog.data === undefined && catalog.error !== null

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <MobileStateView
        icon={GitBranch}
        title={t('sourceControl.folder.emptyTitle', 'No attached worktrees yet')}
        message={t(
          'sourceControl.folder.emptyCopy',
          'Worktrees created from this workspace will show up here.'
        )}
        action={
          catalogFailed
            ? {
                label: t('sourceControl.folder.loadReposRetry', 'Load repositories'),
                onPress: () => void refetchCatalog()
              }
            : null
        }
        bottomInset={props.bottomInset}
      >
        {repos.length > 0 && createClient && name ? (
          <View>
            <SectionHeader title={t('sourceControl.folder.createSection', 'Create a worktree')} />
            <View style={styles.cards}>
              {repos.map((repo) => {
                const target: FolderRepoTarget = {
                  hostId,
                  executionHost: server,
                  folderWorktreeId: folder.worktreeId,
                  repoId: repo.id
                }
                return (
                  <FolderRepoCreateCard
                    key={`${getRepoExecutionHostId(repo)}\0${repo.id}`}
                    target={target}
                    repo={repo}
                    onPress={() => props.onCreate(repo, target, createClient, name)}
                  />
                )
              })}
            </View>
          </View>
        ) : null}
      </MobileStateView>
    </ScrollView>
  )
}

function FolderRepoCreateCard(props: {
  target: FolderRepoTarget
  repo: Repo
  onPress: () => void
}) {
  const t = useMobileTranslation()
  const busy = useSyncExternalStore(subscribeFolderRepoCreates, () =>
    isFolderRepoCreateBusy(props.target)
  )
  return (
    <ListGroup>
      <ListRow
        title={props.repo.displayName}
        leading={<FolderGit2 size={18} color={colors.textSecondary} strokeWidth={1.9} />}
        accessory={
          busy ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Plus size={18} color={colors.textSecondary} strokeWidth={2.2} />
          )
        }
        busy={busy}
        onPress={props.onPress}
        accessibilityRole="button"
        accessibilityLabel={t('sourceControl.folder.createIn', 'Create a worktree in {{repo}}', {
          repo: props.repo.displayName
        })}
      />
    </ListGroup>
  )
}

const styles = themedStyleSheet(() => ({
  scroll: { flexGrow: 1 },
  cards: { gap: spacing.sm }
}))

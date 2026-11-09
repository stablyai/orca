import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, ScrollView, View } from 'react-native'
import { FolderGit2, GitBranch, Plus } from 'lucide-react-native'
import type { Repo } from '../../../../src/shared/repo-types'
import { projectGroupIdFromRepoId } from '../../../../src/shared/folder-workspaces/folder-workspace-worktree'
import { getRepoExecutionHostId } from '../../../../src/shared/execution-host'
import { WORKTREE_CREATE_EXACT_NAME_RUNTIME_CAPABILITY } from '../../../../src/shared/worktree-runtime-capabilities'
import { ListGroup, ListRow, SectionHeader } from '../../components/list/ListGroup'
import { MobileStateView } from '../../components/MobileStateView'
import { NewWorktreeModalController } from '../../components/NewWorktreeModalController'
import type { NewWorktreeFolderLaunch } from '../../components/new-worktree-modal-types'
import { TransientToast, useTransientToast } from '../../components/TransientToast'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { openExternalLink } from '../../platform/external-link'
import { triggerError, triggerSuccess } from '../../platform/haptics'
import { useHostQuery } from '../../query/host-query'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  scopeRpcClientToExecutionHost,
  workspaceRouteExecutionHost
} from '../../worktree/execution-host-scoped-rpc-client'
import type { FolderListRow } from './mobile-folder-attached-worktrees'
import {
  createFolderRepoWorktree,
  folderRepoCreateKey,
  getFolderRepoCreateState,
  subscribeFolderRepoCreates
} from './folder-repo-worktree-create'
import { folderSourceCatalogQuery, selectFolderSourceRepos } from './folder-source-repos-query'

const NO_INPUT = {}
const NO_LABELS = new Map()

type Props = {
  hostId: string
  folder: FolderListRow
  /** The paired desktop's capabilities. */
  desktopCapabilities: readonly string[]
  /** The capabilities of the host the folder lives on: the desktop's, or its server's. */
  folderHostCapabilities: readonly string[]
  /** On screen and on top; reads and late results wait for it. */
  observing: boolean
  refetch: () => void
  bottomInset: number
}

/** A folder with no attached worktrees: desktop's copy, then one create card per repository. */
export function MobileFolderEmptyState(props: Props) {
  const { hostId, folder, desktopCapabilities, folderHostCapabilities, observing, refetch } = props
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
    folderSourceCatalogQuery,
    { hostId, client: canCreate ? createClient : null },
    { exec: server ?? 'local' },
    NO_INPUT,
    { enabled: canCreate, subscribed: observing }
  )
  const repos = useMemo(
    () =>
      canCreate
        ? selectFolderSourceRepos(catalog.data, projectGroupIdFromRepoId(folder.repoId))
        : [],
    [canCreate, catalog.data, folder.repoId]
  )
  const { message, showToast } = useTransientToast()
  const [composer, setComposer] = useState<NewWorktreeFolderLaunch | null>(null)
  // Late answers act only while this screen still shows the folder; a create already sent runs on.
  const observingRef = useRef(observing)
  useEffect(() => {
    observingRef.current = observing
  }, [observing])
  const name = folder.displayName.trim()
  const folderWorktreeId = folder.worktreeId

  const create = useCallback(
    async (repo: Repo, client: RpcClient) => {
      const outcome = await createFolderRepoWorktree({
        key: folderRepoCreateKey({
          hostId,
          executionHost: server,
          folderWorktreeId,
          repoId: repo.id
        }),
        client,
        repoId: repo.id,
        folderWorktreeId,
        name
      })
      if (outcome.kind === 'created' || outcome.kind === 'maybe-created') {
        refetch()
      }
      if (!observingRef.current) {
        return
      }
      if (outcome.kind === 'created') {
        triggerSuccess()
        showToast(
          outcome.warning ??
            t('sourceControl.folder.created', 'Created worktree {{name}} in {{repo}}', {
              name: outcome.name,
              repo: repo.displayName
            })
        )
      } else if (outcome.kind === 'needs-composer') {
        setComposer({
          repoId: repo.id,
          executionHostId: getRepoExecutionHostId(repo),
          name,
          parentWorkspace: folderWorktreeId
        })
      } else if (outcome.kind === 'failed') {
        triggerError()
        showToast(
          outcome.message ||
            t('sourceControl.folder.createFailed', 'Could not create a worktree in {{repo}}.', {
              repo: repo.displayName
            })
        )
      }
    },
    [folderWorktreeId, hostId, name, refetch, server, showToast, t]
  )

  return (
    <>
      <ScrollView contentContainerStyle={styles.scroll}>
        <MobileStateView
          icon={GitBranch}
          title={t('sourceControl.folder.emptyTitle', 'No attached worktrees yet')}
          message={t(
            'sourceControl.folder.emptyCopy',
            'Worktrees created from this workspace will show up here.'
          )}
          bottomInset={props.bottomInset}
        >
          {repos.length > 0 && createClient && name ? (
            <View>
              <SectionHeader title={t('sourceControl.folder.createSection', 'Create a worktree')} />
              <View style={styles.cards}>
                {repos.map((repo) => (
                  <FolderRepoCreateCard
                    key={`${getRepoExecutionHostId(repo)}\0${repo.id}`}
                    createKey={folderRepoCreateKey({
                      hostId,
                      executionHost: server,
                      folderWorktreeId,
                      repoId: repo.id
                    })}
                    repo={repo}
                    onPress={() => void create(repo, createClient)}
                  />
                ))}
              </View>
            </View>
          ) : null}
        </MobileStateView>
      </ScrollView>
      <TransientToast message={message} bottomInset={props.bottomInset} />
      <NewWorktreeModalController
        visible={composer !== null}
        client={desktopClient}
        hostCapabilities={desktopCapabilities}
        hostId={hostId}
        hostLabelById={NO_LABELS}
        openExternalUrl={openExternalLink}
        {...(composer ? { folderLaunch: composer } : {})}
        // The new worktree joins this folder's list; nothing to navigate to.
        onCreated={(_worktreeId, createdName) => {
          refetch()
          showToast(
            t('sourceControl.folder.createdNamed', 'Created worktree {{name}}', {
              name: createdName
            })
          )
        }}
        onClose={() => setComposer(null)}
      />
    </>
  )
}

function FolderRepoCreateCard(props: { createKey: string; repo: Repo; onPress: () => void }) {
  const t = useMobileTranslation()
  const createState = useSyncExternalStore(subscribeFolderRepoCreates, () =>
    getFolderRepoCreateState(props.createKey)
  )
  return (
    <ListGroup>
      <ListRow
        title={props.repo.displayName}
        leading={<FolderGit2 size={18} color={colors.textSecondary} strokeWidth={1.9} />}
        accessory={
          createState ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Plus size={18} color={colors.textSecondary} strokeWidth={2.2} />
          )
        }
        busy={createState !== null}
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

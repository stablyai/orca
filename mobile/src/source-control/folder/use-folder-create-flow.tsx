import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Repo } from '../../../../src/shared/repo-types'
import { getRepoExecutionHostId } from '../../../../src/shared/execution-host'
import { NewWorktreeModalController } from '../../components/NewWorktreeModalController'
import type { MobileWorkspaceRepo } from '../../components/new-worktree-modal-types'
import { TransientToast, useTransientToast } from '../../components/TransientToast'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { openExternalLink } from '../../platform/external-link'
import { triggerError, triggerSuccess } from '../../platform/haptics'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { FolderListRow } from './mobile-folder-attached-worktrees'
import {
  beginFolderComposerSubmission,
  createFolderRepoWorktree,
  getFolderRepoCreatesVersion,
  reconcileFolderRepoCreates,
  releaseFolderComposerReservation,
  subscribeFolderRepoCreates,
  type FolderRepoTarget
} from './folder-repo-worktree-create'

const NO_LABELS = new Map()

/** What a create reads of a repository: its id, name and host. */
export type FolderCreateRepo = Pick<Repo, 'id' | 'displayName' | 'connectionId' | 'executionHostId'>

type ComposerLaunch = {
  target: FolderRepoTarget
  reservation: number
  executionHostId: ReturnType<typeof getRepoExecutionHostId>
  name: string
}

/**
 * The folder screen's creates: direct exact-name creates, the composer they fall back to, and their
 * toasts. Kept above the empty state, so another repository's new card can't close a form being edited.
 */
export function useFolderCreateFlow(args: {
  hostId: string
  folderWorktreeId: string
  /** The folder's server; undefined for the paired desktop's own. */
  executionHost: string | undefined
  desktopCapabilities: readonly string[]
  members: readonly FolderListRow[]
  observing: boolean
  refetch: () => void
  bottomInset: number
}) {
  const { hostId, folderWorktreeId, executionHost, members, observing, refetch } = args
  const t = useMobileTranslation()
  const { client: desktopClient } = useHostClient(hostId)
  const { message, showToast } = useTransientToast()
  const [composer, setComposer] = useState<ComposerLaunch | null>(null)
  const composerRef = useRef(composer)
  useEffect(() => {
    composerRef.current = composer
  }, [composer])
  // Late answers show nothing once this screen is left or covered; the create itself still settles.
  const presentingRef = useRef(observing)
  useEffect(() => {
    presentingRef.current = observing
    return () => {
      presentingRef.current = false
    }
  }, [observing])
  const presenting = useCallback(() => presentingRef.current, [])

  // A created or unconfirmed create is done once the folder lists a worktree from its repository.
  const createsVersion = useSyncExternalStore(
    subscribeFolderRepoCreates,
    getFolderRepoCreatesVersion
  )
  useEffect(() => {
    reconcileFolderRepoCreates({ hostId, executionHost, folderWorktreeId }, members)
  }, [createsVersion, executionHost, folderWorktreeId, hostId, members])

  const onCreate = useCallback(
    async (repo: FolderCreateRepo, target: FolderRepoTarget, client: RpcClient, name: string) => {
      const outcome = await createFolderRepoWorktree({ target, client, name })
      if (outcome.kind === 'created' || outcome.kind === 'maybe-created') {
        refetch()
      }
      if (outcome.kind === 'needs-composer' && (!presenting() || composerRef.current)) {
        // Left, or another form is open: keep that form and leave this repository to try again.
        releaseFolderComposerReservation(target, outcome.reservation)
        return
      }
      if (!presenting()) {
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
          target,
          reservation: outcome.reservation,
          executionHostId: getRepoExecutionHostId(repo),
          name
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
    [presenting, refetch, showToast, t]
  )

  const launch = composer
  const composerElement = (
    <NewWorktreeModalController
      visible={launch !== null}
      client={desktopClient}
      hostCapabilities={args.desktopCapabilities}
      hostId={hostId}
      hostLabelById={NO_LABELS}
      openExternalUrl={openExternalLink}
      {...(launch
        ? {
            folderLaunch: {
              repoId: launch.target.repoId,
              executionHostId: launch.executionHostId,
              name: launch.name,
              parentWorkspace: folderWorktreeId,
              submit: {
                begin: (repo: MobileWorkspaceRepo) =>
                  beginFolderComposerSubmission(
                    { ...launch.target, repoId: repo.id },
                    { target: launch.target, reservation: launch.reservation },
                    () => composerRef.current === launch
                  ),
                presenting
              }
            }
          }
        : {})}
      onCreated={(_worktreeId, createdName, warning) => {
        refetch()
        if (presenting()) {
          showToast(
            warning ??
              t('sourceControl.folder.createdNamed', 'Created worktree {{name}}', {
                name: createdName
              })
          )
        }
      }}
      onClose={() => {
        // Only this opening's close: an older submission settling can't close a newer form.
        if (launch) {
          releaseFolderComposerReservation(launch.target, launch.reservation)
        }
        setComposer((current) => (current === launch ? null : current))
      }}
    />
  )
  const toastElement = <TransientToast message={message} bottomInset={args.bottomInset} />
  return { onCreate, composerElement, toastElement }
}

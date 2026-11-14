import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Repo } from '../../../../src/shared/repo-types'
import { getRepoExecutionHostId } from '../../../../src/shared/execution-host'
import { ConfirmModal } from '../../components/ConfirmModal'
import { NewWorktreeModalController } from '../../new-workspace/creation/modal/NewWorktreeModalController'
import type { MobileWorkspaceRepo } from '../../new-workspace/creation/forms/new-worktree-modal-types'
import { TransientToast, useTransientToast } from '../../components/TransientToast'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { openExternalLink } from '../../platform/external-links/external-link'
import { triggerError, triggerSuccess } from '../../platform/haptics/haptics'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { FolderListRow } from './mobile-folder-attached-worktrees'
import {
  beginFolderComposerSubmission,
  createFolderRepoWorktree,
  getFolderRepoCreatesVersion,
  isFolderRepoHoldPending,
  reconcileFolderRepoCreates,
  releaseFolderComposerReservation,
  subscribeFolderRepoCreates,
  type FolderRepoTarget
} from './folder-repo-worktree-create'

const NO_LABELS = new Map()

/** What a create reads of a repository: its id, name and host. */
export type FolderCreateRepo = Pick<Repo, 'id' | 'displayName' | 'connectionId' | 'executionHostId'>

type SetupChoice = {
  /** The unconfirmed create it resends; once that is gone the dialog closes and sends nothing. */
  hold: number
  repo: FolderCreateRepo
  target: FolderRepoTarget
  client: RpcClient
  name: string
}

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
  const [setupChoice, setSetupChoice] = useState<SetupChoice | null>(null)
  // The one form on screen, composer or setup choice. Set as forms open and close, not after render, so
  // two answers landing together can't both open one.
  const openRef = useRef<ComposerLaunch | SetupChoice | null>(null)
  // The newest form opened, still set after it closes: an older form's late answer shows nothing over it.
  const latestRef = useRef<ComposerLaunch | SetupChoice | null>(null)
  // Late answers show nothing once this screen is left or covered; the create itself still settles.
  const presentingRef = useRef(observing)
  useEffect(() => {
    presentingRef.current = observing
  }, [observing])
  useEffect(
    () => () => {
      presentingRef.current = false
      latestRef.current = null
      const open = openRef.current
      openRef.current = null
      // Left without sending from the form: its repository takes taps again.
      if (open && 'reservation' in open) {
        releaseFolderComposerReservation(open.target, open.reservation)
      }
    },
    []
  )
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
    async (
      repo: FolderCreateRepo,
      target: FolderRepoTarget,
      client: RpcClient,
      name: string,
      skipSetupFor?: number
    ) => {
      const outcome = await createFolderRepoWorktree({ target, client, name, skipSetupFor })
      if (
        outcome.kind === 'created' ||
        outcome.kind === 'maybe-created' ||
        outcome.kind === 'checking'
      ) {
        refetch()
      }
      const opensForm = outcome.kind === 'needs-composer' || outcome.kind === 'needs-setup-choice'
      if (opensForm && (!presenting() || openRef.current)) {
        // Left, or another form is open: keep that form and leave this repository to try again.
        if (outcome.kind === 'needs-composer') {
          releaseFolderComposerReservation(target, outcome.reservation)
        }
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
      } else if (outcome.kind === 'checking') {
        showToast(
          t(
            'sourceControl.folder.checking',
            'A worktree from {{repo}} may already have been created. Checking the folder…',
            { repo: repo.displayName }
          )
        )
      } else if (outcome.kind === 'needs-setup-choice') {
        const choice = { hold: outcome.hold, repo, target, client, name }
        openRef.current = choice
        latestRef.current = choice
        setSetupChoice(choice)
      } else if (outcome.kind === 'needs-composer') {
        const launch = {
          target,
          reservation: outcome.reservation,
          executionHostId: getRepoExecutionHostId(repo),
          name
        }
        openRef.current = launch
        latestRef.current = launch
        setComposer(launch)
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
  const presentingLaunch = (opened: ComposerLaunch | null) =>
    presenting() && opened !== null && latestRef.current === opened
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
                begin: (repo: MobileWorkspaceRepo) => {
                  const submission = beginFolderComposerSubmission(
                    { ...launch.target, repoId: repo.id },
                    launch,
                    () => openRef.current === launch
                  )
                  return (
                    submission && {
                      settle: (outcome) => {
                        submission.settle(outcome)
                        // A lost reply may have created it: the list shows it, or the form keeps it from being sent twice.
                        if (outcome === 'uncertain') {
                          refetch()
                        }
                      }
                    }
                  )
                },
                presenting: () => presentingLaunch(launch)
              }
            }
          }
        : {})}
      onCreated={(_worktreeId, createdName, warning) => {
        refetch()
        if (presentingLaunch(launch)) {
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
          if (openRef.current === launch) {
            openRef.current = null
          }
        }
        setComposer((current) => (current === launch ? null : current))
      }}
    />
  )
  const choice = setupChoice
  // Only this dialog's own answer: it closes itself and nothing newer.
  const closeChoice = useCallback((closing: SetupChoice | null) => {
    if (openRef.current === closing) {
      openRef.current = null
    }
    setSetupChoice((current) => (current === closing ? null : current))
  }, [])
  // The folder showed it, or another create replaced it: there is nothing left to retry.
  useEffect(() => {
    if (choice && !isFolderRepoHoldPending(choice.target, choice.hold)) {
      closeChoice(choice)
    }
  }, [choice, closeChoice, createsVersion])
  const setupChoiceElement = (
    <ConfirmModal
      visible={setupChoice !== null}
      title={t('sourceControl.folder.setupChoiceTitle', 'Retry without setup?')}
      message={t(
        'sourceControl.folder.setupChoiceMessage',
        "Orca couldn't confirm the last create in {{repo}}. Retrying it needs a setup choice; it will be created without running the repository's setup.",
        { repo: choice?.repo.displayName ?? '' }
      )}
      confirmLabel={t('sourceControl.folder.setupChoiceSkip', 'Retry without setup')}
      onConfirm={() => {
        if (choice && openRef.current === choice) {
          closeChoice(choice)
          void onCreate(choice.repo, choice.target, choice.client, choice.name, choice.hold)
        }
      }}
      onCancel={() => closeChoice(choice)}
    />
  )
  const toastElement = <TransientToast message={message} bottomInset={args.bottomInset} />
  return {
    onCreate,
    /** A form covers the screen: the list under it waits. */
    covered: composer !== null || setupChoice !== null,
    composerElement: (
      <>
        {composerElement}
        {setupChoiceElement}
      </>
    ),
    toastElement
  }
}

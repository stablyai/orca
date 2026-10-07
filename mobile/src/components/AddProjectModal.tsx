import { useCallback, useRef, useState } from 'react'
import { View } from 'react-native'
import { FolderOpen, Globe, Plus } from 'lucide-react-native'
import { REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import {
  repoAddExistingRun,
  repoCloneRun,
  repoCreateRun
} from '../tasks/repo-add-project-operations'
import { REPO_CLONE_TIMEOUT_MS } from '../tasks/workspace-create-timeout'
import type { RpcClient } from '../transport/rpc-client'
import { ActionSheetContent } from './ActionSheetModal'
import { AddProjectFolderBrowser } from './AddProjectFolderBrowser'
import { AddProjectTargetSelector, type AddProjectTarget } from './AddProjectTargetSelector'
import { BottomDrawer } from './BottomDrawer'
import { ConfirmContent } from './ConfirmModal'
import { AddProjectForm } from './AddProjectForm'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'
import { useAddProjectOperationScope } from './useAddProjectOperationScope'
type AddProjectView =
  | 'start'
  | 'clone'
  | 'create'
  | 'addExisting'
  | 'confirmFolder'
  | 'pickDestination'
const NOT_A_GIT_REPOSITORY = 'Not a valid git repository'
const EMPTY_HOST_CAPABILITIES: readonly string[] = []
const EMPTY_SSH_TARGETS: readonly {
  id: string
  label: string
  connected?: boolean
  connectionStatus?: string
}[] = []
type AddProjectModalProps = {
  visible: boolean
  client: RpcClient | null
  onProjectAdded: (repo: MobileWorkspaceRepo) => void
  onClose: () => void
  hostCapabilities?: readonly string[]
  sshTargets?: readonly {
    id: string
    label: string
    connected?: boolean
    connectionStatus?: string
  }[]
}

type AddedRepo = {
  id: string
  path: string
  displayName: string
  connectionId?: string | null
  executionHostId?: string | null
}
type FolderCandidate = { path: string; sshConnectionId: string | null; client: RpcClient }

function toMobileRepo(repo: AddedRepo): MobileWorkspaceRepo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the receipt's looseObject keeps every member the host sent; the trio it requires is exactly what MobileWorkspaceRepo requires.
  return repo as MobileWorkspaceRepo
}

/**
 * The Add project sheet from the + action sheet: the desktop Add project start steps minus
 * the SSH row, then one form per row. A successful add closes the sheet and hands the repo
 * to `onProjectAdded` — from `onAfterClose`, so the default-checkout session it opens is
 * presented only after this sheet's native window unmounted.
 */
export function AddProjectModal({
  visible,
  client,
  onProjectAdded,
  onClose,
  hostCapabilities = EMPTY_HOST_CAPABILITIES,
  sshTargets = EMPTY_SSH_TARGETS
}: AddProjectModalProps) {
  const [session, setSession] = useState({ openEpoch: 0, visible })
  if (session.visible !== visible) {
    setSession({
      openEpoch: visible ? session.openEpoch + 1 : session.openEpoch,
      visible
    })
  }

  const handoffRef = useRef<{
    repo: MobileWorkspaceRepo
    client: RpcClient | null
    openEpoch: number
  } | null>(null)
  const latestClientRef = useRef(client)
  if (latestClientRef.current !== client) {
    latestClientRef.current = client
    handoffRef.current = null
  }
  const fireHandoff = useCallback(() => {
    const handoff = handoffRef.current
    handoffRef.current = null
    if (
      handoff &&
      handoff.openEpoch === session.openEpoch &&
      handoff.client === latestClientRef.current
    ) {
      onProjectAdded(handoff.repo)
    }
  }, [onProjectAdded, session.openEpoch])

  return (
    <AddProjectModalContent
      key={session.openEpoch}
      visible={visible}
      openEpoch={session.openEpoch}
      client={client}
      onClose={onClose}
      onAfterClose={fireHandoff}
      hostCapabilities={hostCapabilities}
      sshTargets={sshTargets}
      onAdded={(repo) => {
        handoffRef.current = { repo, client, openEpoch: session.openEpoch }
        onClose()
      }}
    />
  )
}

function AddProjectModalContent({
  visible,
  openEpoch,
  client,
  onAdded,
  onClose,
  onAfterClose,
  hostCapabilities,
  sshTargets
}: {
  visible: boolean
  openEpoch: number
  client: RpcClient | null
  onAdded: (repo: MobileWorkspaceRepo) => void
  onClose: () => void
  onAfterClose: () => void
  hostCapabilities: readonly string[]
  sshTargets: readonly {
    id: string
    label: string
    connected?: boolean
    connectionStatus?: string
  }[]
}) {
  const [view, setView] = useState<AddProjectView>('start')
  const [cloneUrl, setCloneUrl] = useState('')
  const [projectName, setProjectName] = useState('')
  const [folderCandidate, setFolderCandidate] = useState<FolderCandidate | null>(null)
  const [destinationPath, setDestinationPath] = useState('')
  const [destinationKind, setDestinationKind] = useState<'clone' | 'create' | null>(null)
  const [error, setError] = useState('')
  const [sshConnectionId, setSshConnectionId] = useState<string | null>(null)
  const confirmingFolderRef = useRef(false)

  const value = view === 'clone' ? cloneUrl : projectName
  const sshSupported = hostCapabilities.includes(REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY)
  const targetOptions: AddProjectTarget[] = hostCapabilities.includes(
    REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY
  )
    ? [{ id: null, label: 'This host' }, ...sshTargets]
    : []
  const activeSshConnectionId =
    sshSupported && targetOptions.some((target) => target.id === sshConnectionId)
      ? sshConnectionId
      : null
  const selectedTargetAvailable = sshConnectionId === null || activeSshConnectionId !== null
  const operationScope = {
    client,
    visible,
    openEpoch,
    selectedTargetId: sshConnectionId,
    sshCapability: sshSupported,
    selectedTargetAvailable
  }
  const { busy, busyRef, begin, current, finish, invalidate } =
    useAddProjectOperationScope(operationScope)
  const requestTarget =
    activeSshConnectionId && selectedTargetAvailable
      ? { sshConnectionId: activeSshConnectionId }
      : {}
  const canSubmit = value.trim().length > 0 && !busy && client != null && selectedTargetAvailable
  const selectTarget = (id: string | null) => {
    if (id !== activeSshConnectionId) {
      invalidate()
      setDestinationPath('')
    }
    setSshConnectionId(id)
  }

  const submit = useCallback(() => {
    if (!canSubmit || !client) {
      return
    }
    const operation = begin()
    if (!operation) {
      return
    }
    setError('')
    const run = async (): Promise<MobileWorkspaceRepo> => {
      if (view === 'clone') {
        const reply = repoCloneRun.interpret(
          await repoCloneRun.request(
            client,
            {
              url: cloneUrl.trim(),
              ...(destinationPath ? { destination: destinationPath } : {}),
              ...requestTarget
            },
            {
              timeoutMs: REPO_CLONE_TIMEOUT_MS
            }
          )
        )
        return toMobileRepo(reply.repo)
      }
      if (view === 'create') {
        const reply = repoCreateRun.interpret(
          await repoCreateRun.request(client, {
            name: projectName.trim(),
            kind: 'git',
            ...(destinationPath ? { parentPath: destinationPath } : {}),
            ...requestTarget
          })
        )
        if ('error' in reply) {
          throw new Error(reply.error || 'Failed to create the project')
        }
        return toMobileRepo(reply.repo)
      }
      throw new Error('Unsupported add project step')
    }
    run()
      .then((repo) => {
        if (current(operation)) {
          onAdded(repo)
        }
      })
      .catch((cause: unknown) => {
        if (current(operation)) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        finish(operation)
      })
  }, [
    begin,
    canSubmit,
    client,
    cloneUrl,
    current,
    finish,
    onAdded,
    projectName,
    requestTarget,
    view
  ])

  const addFolder = useCallback(
    async (path: string, kind: 'git' | 'folder'): Promise<void> => {
      if (!client || busy || busyRef.current || !selectedTargetAvailable) {
        return
      }
      const operation = begin()
      if (!operation) {
        return
      }
      setError('')
      try {
        const reply = repoAddExistingRun.interpret(
          await repoAddExistingRun.request(client, { path, kind, ...requestTarget })
        )
        if (current(operation)) {
          onAdded(toMobileRepo(reply.repo))
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        const isCurrent = current(operation)
        if (isCurrent && kind === 'git' && message.includes(NOT_A_GIT_REPOSITORY)) {
          setFolderCandidate({ path, sshConnectionId: activeSshConnectionId, client })
          setView('confirmFolder')
        } else if (isCurrent) {
          setError(message)
          setView('addExisting')
        }
      } finally {
        finish(operation)
      }
    },
    [begin, busy, busyRef, client, current, finish, onAdded, requestTarget, selectedTargetAvailable]
  )

  const targetSelector = (
    <AddProjectTargetSelector
      busy={busy}
      targets={targetOptions}
      selectedId={sshConnectionId}
      onSelect={selectTarget}
    />
  )

  const invalidTargetMessage = !selectedTargetAvailable
    ? 'Choose a valid SSH target before submitting.'
    : ''
  const formHint = activeSshConnectionId
    ? view === 'clone'
      ? 'Choose a destination folder on the selected host. Large repositories can take a few minutes.'
      : 'Choose a parent folder on the selected host for the new project.'
    : view === 'clone'
      ? "Cloned into the host's default projects folder. Large repositories can take a few minutes."
      : "An empty git repository with an initial commit, created in the host's default projects folder."
  const content = (() => {
    if (view === 'start') {
      return (
        <View>
          {targetSelector}
          <ActionSheetContent
            title="Add project"
            actions={[
              {
                label: 'Browse folder',
                icon: FolderOpen,
                hint: 'Existing Git repository or folder on this host',
                onPress: () => setView('addExisting')
              },
              {
                label: 'Clone from URL',
                icon: Globe,
                hint: 'Clone a remote Git repository',
                onPress: () => {
                  if (activeSshConnectionId) {
                    setDestinationKind('clone')
                  }
                  setView(activeSshConnectionId ? 'pickDestination' : 'clone')
                }
              },
              {
                label: 'Create new project',
                icon: Plus,
                hint: 'Start from an empty folder',
                onPress: () => {
                  if (activeSshConnectionId) {
                    setDestinationKind('create')
                  }
                  setView(activeSshConnectionId ? 'pickDestination' : 'create')
                }
              }
            ]}
          />
        </View>
      )
    }

    if (view === 'addExisting') {
      return (
        <View>
          {targetSelector}
          <AddProjectFolderBrowser
            client={client}
            sshConnectionId={activeSshConnectionId}
            busy={busy}
            error={error}
            onBack={() => setView('start')}
            onPick={(path) => void addFolder(path, 'git')}
          />
        </View>
      )
    }

    if (view === 'pickDestination') {
      return (
        <View>
          <AddProjectFolderBrowser
            client={client}
            sshConnectionId={activeSshConnectionId}
            busy={busy}
            error={error}
            pickLabel="Select folder"
            onBack={() => setView(destinationKind ?? 'start')}
            onPick={(path) => {
              setDestinationPath(path)
              setView(destinationKind ?? 'start')
            }}
          />
        </View>
      )
    }

    if (view === 'confirmFolder') {
      return (
        <ConfirmContent
          title="Add as a folder project?"
          message={`${folderCandidate?.path ?? ''} is not a Git repository. Folder projects have no worktrees, source control, pull requests, or checks.`}
          confirmLabel="Add folder"
          onConfirm={() => {
            confirmingFolderRef.current = true
            if (
              !folderCandidate ||
              folderCandidate.client !== client ||
              folderCandidate.sshConnectionId !== activeSshConnectionId
            ) {
              setError('The host or SSH target changed. Choose the folder again.')
              setView('addExisting')
              confirmingFolderRef.current = false
              return
            }
            void addFolder(folderCandidate.path, 'folder')
          }}
          onCancel={() => {
            if (!confirmingFolderRef.current) {
              setView('addExisting')
            }
            confirmingFolderRef.current = false
          }}
        />
      )
    }

    return (
      <View>
        {targetSelector}
        <AddProjectForm
          mode={view}
          value={value}
          busy={busy}
          error={error}
          invalidTargetMessage={invalidTargetMessage}
          hint={formHint}
          onChangeText={view === 'clone' ? setCloneUrl : setProjectName}
          onBack={() => setView('start')}
          onSubmit={submit}
        />
      </View>
    )
  })()

  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      onAfterClose={onAfterClose}
      contentScrollable={view !== 'addExisting' && view !== 'pickDestination'}
    >
      {content}
    </BottomDrawer>
  )
}

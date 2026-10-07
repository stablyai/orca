import { useCallback, useRef, useState } from 'react'
import { View } from 'react-native'
import {
  repoAddExistingRun,
  repoCloneRun,
  repoCreateRun
} from '../tasks/repo-add-project-operations'
import { REPO_CLONE_TIMEOUT_MS } from '../tasks/workspace-create-timeout'
import type { RpcClient } from '../transport/rpc-client'
import { AddProjectStart } from './AddProjectStart'
import { AddProjectTargetRecovery } from './AddProjectTargetRecovery'
import { AddProjectFolderView } from './AddProjectFolderView'
import { AddProjectTargetSelectorView } from './AddProjectTargetSelectorView'
import { BottomDrawer } from './BottomDrawer'
import { AddProjectFolderConfirmation } from './AddProjectFolderConfirmation'
import { AddProjectForm, addProjectFormHint } from './AddProjectForm'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'
import {
  EMPTY_HOST_CAPABILITIES,
  EMPTY_SSH_TARGETS,
  createAddProjectScope,
  toMobileRepo,
  type AddProjectModalProps,
  type AddProjectView,
  type AddProjectHandoff,
  type FolderCandidate
} from './addProjectTypes'
import { useAddProjectOperationScope } from './useAddProjectOperationScope'
import { resolveAddProjectTargetState, selectAddProjectTarget } from './addProjectTargetState'
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
  const handoffRef = useRef<AddProjectHandoff | null>(null)
  const latestClientRef = useRef(client)
  if (latestClientRef.current !== client) {
    latestClientRef.current = client
    handoffRef.current = null
  }
  const latestSessionRef = useRef(session)
  latestSessionRef.current = session
  const fireHandoff = useCallback(() => {
    const handoff = handoffRef.current
    handoffRef.current = null
    const latestSession = latestSessionRef.current
    if (
      handoff &&
      latestSession.visible === false &&
      handoff.openEpoch === latestSession.openEpoch &&
      handoff.client === latestClientRef.current
    ) {
      onProjectAdded(handoff.repo)
    }
  }, [onProjectAdded])
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
  const valueForSubmit = view === 'clone' ? cloneUrl : projectName
  const { sshSupported, targetOptions, activeSshConnectionId, selectedTargetAvailable } =
    resolveAddProjectTargetState(hostCapabilities, sshTargets, sshConnectionId)
  const operationScope = createAddProjectScope({
    client,
    visible,
    openEpoch,
    selectedTargetId: sshConnectionId,
    sshCapability: sshSupported,
    selectedTargetAvailable
  })
  const { busy, busyRef, begin, current, finish, invalidate } =
    useAddProjectOperationScope(operationScope)
  const requestTarget =
    activeSshConnectionId && selectedTargetAvailable
      ? { sshConnectionId: activeSshConnectionId }
      : {}
  const canSubmit =
    valueForSubmit.trim().length > 0 && !busy && client != null && selectedTargetAvailable
  const selectTarget = (id: string | null) =>
    selectAddProjectTarget(
      id,
      activeSshConnectionId,
      invalidate,
      () => setDestinationPath(''),
      setSshConnectionId
    )
  const submit = useCallback(() => {
    if (!canSubmit || !client) {
      return
    }
    const operation = begin(operationScope)
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
    operationScope,
    projectName,
    requestTarget,
    view
  ])

  const addFolder = useCallback(
    async (path: string, kind: 'git' | 'folder'): Promise<void> => {
      if (!client || busy || busyRef.current || !selectedTargetAvailable) {
        return
      }
      const operation = begin(operationScope)
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
        if (isCurrent && kind === 'git' && message.includes('Not a valid git repository')) {
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
    [
      begin,
      busy,
      busyRef,
      client,
      current,
      finish,
      onAdded,
      operationScope,
      requestTarget,
      selectedTargetAvailable
    ]
  )

  const invalidTargetMessage = !selectedTargetAvailable
    ? 'Choose a valid SSH target before submitting.'
    : ''
  const content = (() => {
    if (view === 'start') {
      return (
        <View>
          <AddProjectStart
            targetSelector={
              <AddProjectTargetSelectorView
                busy={busy}
                targets={targetOptions}
                selectedId={sshConnectionId}
                onSelect={selectTarget}
              />
            }
            onBrowse={() => setView('addExisting')}
            onClone={() => {
              if (activeSshConnectionId) {
                setDestinationKind('clone')
              }
              setView(activeSshConnectionId ? 'pickDestination' : 'clone')
            }}
            onCreate={() => {
              if (activeSshConnectionId) {
                setDestinationKind('create')
              }
              setView(activeSshConnectionId ? 'pickDestination' : 'create')
            }}
          />
        </View>
      )
    }

    if ((view === 'addExisting' || view === 'pickDestination') && !selectedTargetAvailable) {
      return (
        <View>
          <AddProjectTargetRecovery
            onChooseThisHost={() => {
              setSshConnectionId(null)
              setDestinationPath('')
              setFolderCandidate(null)
              setView('start')
            }}
          />
        </View>
      )
    }

    if (view === 'addExisting' || view === 'pickDestination') {
      return (
        <AddProjectFolderView
          targetSelector={
            <AddProjectTargetSelectorView
              busy={busy}
              targets={targetOptions}
              selectedId={sshConnectionId}
              onSelect={selectTarget}
            />
          }
          destination={view === 'pickDestination'}
          client={client}
          sshConnectionId={activeSshConnectionId}
          busy={busy}
          error={error}
          destinationPath={activeSshConnectionId ? destinationPath : undefined}
          onBack={() =>
            setView(view === 'pickDestination' ? (destinationKind ?? 'start') : 'start')
          }
          onPick={(path) => {
            if (view === 'pickDestination') {
              setDestinationPath(path)
              setView(destinationKind ?? 'start')
            } else {
              void addFolder(path, 'git')
            }
          }}
        />
      )
    }

    if (view === 'confirmFolder') {
      return (
        <AddProjectFolderConfirmation
          path={folderCandidate?.path ?? ''}
          client={folderCandidate?.client ?? null}
          sshConnectionId={folderCandidate ? folderCandidate.sshConnectionId : undefined}
          confirmingRef={confirmingFolderRef}
          onConfirmFolder={() => {
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
          onChanged={() => {
            setError('The host or SSH target changed. Choose the folder again.')
            setView('addExisting')
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
        <AddProjectTargetSelectorView
          busy={busy}
          targets={targetOptions}
          selectedId={sshConnectionId}
          onSelect={selectTarget}
        />
        <AddProjectForm
          mode={view}
          value={view === 'clone' ? cloneUrl : projectName}
          busy={busy}
          error={error}
          invalidTargetMessage={invalidTargetMessage}
          hint={addProjectFormHint(view, Boolean(activeSshConnectionId))}
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

import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { ChevronLeft, FolderOpen, Globe, Plus } from 'lucide-react-native'
import { REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import {
  repoAddExistingRun,
  repoCloneRun,
  repoCreateRun
} from '../tasks/repo-add-project-operations'
import { REPO_CLONE_TIMEOUT_MS } from '../tasks/workspace-create-timeout'
import type { RpcClient } from '../transport/rpc-client'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { ActionSheetContent } from './ActionSheetModal'
import { AddProjectFolderBrowser } from './AddProjectFolderBrowser'
import { AddProjectTargetSelector, type AddProjectTarget } from './AddProjectTargetSelector'
import { BottomDrawer } from './BottomDrawer'
import { ConfirmContent } from './ConfirmModal'
import { newWorktreeFormStyles as formStyles } from './new-worktree-form-styles'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'

type AddProjectView = 'start' | 'clone' | 'create' | 'addExisting' | 'confirmFolder' | 'pickDestination'

const NOT_A_GIT_REPOSITORY = 'Not a valid git repository'
const EMPTY_HOST_CAPABILITIES: readonly string[] = []
const EMPTY_SSH_TARGETS: readonly { id: string; label: string; connected?: boolean; connectionStatus?: string }[] = []

type AddProjectModalProps = {
  visible: boolean
  client: RpcClient | null
  onProjectAdded: (repo: MobileWorkspaceRepo) => void
  onClose: () => void
  hostCapabilities?: readonly string[]
  sshTargets?: readonly { id: string; label: string; connected?: boolean; connectionStatus?: string }[]
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

  const handoffRef = useRef<MobileWorkspaceRepo | null>(null)
  const fireHandoff = useCallback(() => {
    const repo = handoffRef.current
    handoffRef.current = null
    if (repo) {
      onProjectAdded(repo)
    }
  }, [onProjectAdded])

  return (
    <AddProjectModalContent
      key={session.openEpoch}
      visible={visible}
      client={client}
      onClose={onClose}
      onAfterClose={fireHandoff}
      hostCapabilities={hostCapabilities}
      sshTargets={sshTargets}
      onAdded={(repo) => {
        handoffRef.current = repo
        onClose()
      }}
    />
  )
}

function AddProjectModalContent({
  visible,
  client,
  onAdded,
  onClose,
  onAfterClose,
  hostCapabilities,
  sshTargets
}: {
  visible: boolean
  client: RpcClient | null
  onAdded: (repo: MobileWorkspaceRepo) => void
  onClose: () => void
  onAfterClose: () => void
  hostCapabilities: readonly string[]
  sshTargets: readonly { id: string; label: string; connected?: boolean; connectionStatus?: string }[]
}) {
  const [view, setView] = useState<AddProjectView>('start')
  const [cloneUrl, setCloneUrl] = useState('')
  const [projectName, setProjectName] = useState('')
  const [folderCandidate, setFolderCandidate] = useState<FolderCandidate | null>(null)
  const [destinationPath, setDestinationPath] = useState('')
  const [destinationKind, setDestinationKind] = useState<'clone' | 'create' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mountedRef = useRef(true)
  const busyRef = useRef(false)
  const operationGenerationRef = useRef(0)
  const latestClientRef = useRef(client)
  latestClientRef.current = client
  const [sshConnectionId, setSshConnectionId] = useState<string | null>(null)
  const confirmingFolderRef = useRef(false)

  const value = view === 'clone' ? cloneUrl : projectName
  const canSubmit = value.trim().length > 0 && !busy && client != null
  const sshSupported = hostCapabilities.includes(REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY)
  const targetOptions: AddProjectTarget[] = hostCapabilities.includes(REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY)
    ? [{ id: null, label: 'This host' }, ...sshTargets]
    : []
  const activeSshConnectionId = sshSupported && targetOptions.some((target) => target.id === sshConnectionId) ? sshConnectionId : null
  const requestTarget = activeSshConnectionId ? { sshConnectionId: activeSshConnectionId } : {}
  const selectTarget = (id: string | null) => {
    if (id !== activeSshConnectionId) { setDestinationPath('') }
    setSshConnectionId(id)
  }

  useEffect(() => () => { mountedRef.current = false }, [])

  const submit = useCallback(() => {
    if (!canSubmit || !client || busyRef.current) {
      return
    }
    const operationGeneration = operationGenerationRef.current + 1
    operationGenerationRef.current = operationGeneration
    busyRef.current = true
    setBusy(true)
    setError('')
    const run = async (): Promise<MobileWorkspaceRepo> => {
      if (view === 'clone') {
        const reply = repoCloneRun.interpret(
          await repoCloneRun.request(
            client,
            { url: cloneUrl.trim(), ...(destinationPath ? { destination: destinationPath } : {}), ...requestTarget },
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
    const current = () => mountedRef.current && operationGenerationRef.current === operationGeneration && latestClientRef.current === client
    run()
      .then((repo) => { if (current()) { onAdded(repo) } })
      .catch((cause: unknown) => {
        if (current()) { setError(cause instanceof Error ? cause.message : String(cause)) }
      })
      .finally(() => { if (current()) { busyRef.current = false; setBusy(false) } })
  }, [canSubmit, client, cloneUrl, onAdded, projectName, requestTarget, view])

  const addFolder = useCallback(
    async (path: string, kind: 'git' | 'folder'): Promise<void> => {
      if (!client || busy || busyRef.current) {
        return
      }
      const operationGeneration = operationGenerationRef.current + 1
      operationGenerationRef.current = operationGeneration
      busyRef.current = true
      setBusy(true)
      setError('')
      try {
        const reply = repoAddExistingRun.interpret(
          await repoAddExistingRun.request(client, { path, kind, ...requestTarget })
        )
        if (mountedRef.current && operationGenerationRef.current === operationGeneration && latestClientRef.current === client) {
          onAdded(toMobileRepo(reply.repo))
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        const current = mountedRef.current && operationGenerationRef.current === operationGeneration && latestClientRef.current === client
        if (current && kind === 'git' && message.includes(NOT_A_GIT_REPOSITORY)) {
          setFolderCandidate({ path, sshConnectionId: activeSshConnectionId, client })
          setView('confirmFolder')
        } else if (current) {
          setError(message)
          setView('addExisting')
        }
      } finally {
        if (mountedRef.current && operationGenerationRef.current === operationGeneration) {
          busyRef.current = false
          setBusy(false)
        }
      }
    },
    [busy, client, onAdded, requestTarget]
  )

  const targetSelector = (
    <AddProjectTargetSelector
      busy={busy}
      targets={targetOptions}
      selectedId={sshConnectionId}
      onSelect={selectTarget}
    />
  )

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
                if (activeSshConnectionId) { setDestinationKind('clone') }
                setView(activeSshConnectionId ? 'pickDestination' : 'clone')
              }
            },
            {
              label: 'Create new project',
              icon: Plus,
              hint: 'Start from an empty folder',
              onPress: () => {
                if (activeSshConnectionId) { setDestinationKind('create') }
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
            onPick={(path) => { setDestinationPath(path); setView(destinationKind ?? 'start') }}
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
            if (!folderCandidate || folderCandidate.client !== client || folderCandidate.sshConnectionId !== activeSshConnectionId) {
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

    const copy = {
      clone: {
        title: 'Clone from URL',
        label: 'Repository URL',
        placeholder: 'https://github.com/owner/repo',
        hint: activeSshConnectionId
          ? 'Choose a destination folder on the selected host. Large repositories can take a few minutes.'
          : "Cloned into the host's default projects folder. Large repositories can take a few minutes.",
        button: 'Clone repository'
      },
      create: {
        title: 'Create new project',
        label: 'Project name',
        placeholder: 'my-project',
        hint: activeSshConnectionId
          ? 'Choose a parent folder on the selected host for the new project.'
          : "An empty git repository with an initial commit, created in the host's default projects folder.",
        button: 'Create project'
      }
    }[view]

    return (
      <View>
        {targetSelector}
        <View style={styles.headerRow}>
          <Pressable
            style={styles.backButton}
            onPress={() => setView('start')}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Back to Add project"
          >
            <ChevronLeft size={18} color={colors.textSecondary} />
          </Pressable>
          <Text style={formStyles.title}>{copy.title}</Text>
        </View>

        <View style={formStyles.field}>
          <Text style={formStyles.label}>{copy.label}</Text>
          <TextInput
            style={formStyles.input}
            value={value}
            onChangeText={view === 'clone' ? setCloneUrl : setProjectName}
            placeholder={copy.placeholder}
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={view === 'clone' ? 'url' : 'default'}
            editable={!busy}
            accessibilityLabel={copy.label}
          />
          <Text style={styles.hint}>{copy.hint}</Text>
        </View>

        {error ? <Text style={formStyles.error}>{error}</Text> : null}
        <View style={formStyles.actions}>
          <Pressable
            style={[formStyles.createButton, !canSubmit && formStyles.createButtonDisabled]}
            disabled={!canSubmit}
            onPress={submit}
            accessibilityRole="button"
            accessibilityLabel={copy.button}
          >
            {busy ? (
              <ActivityIndicator size="small" color={colors.bgBase} />
            ) : (
              <Text style={formStyles.createText}>{copy.button}</Text>
            )}
          </Pressable>
        </View>
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

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.md },
  backButton: {
    marginLeft: -spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  hint: { marginTop: spacing.xs, fontSize: typography.metaSize, color: colors.textMuted }
})

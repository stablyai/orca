import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { ChevronLeft, FolderOpen, Globe, Plus } from 'lucide-react-native'
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
import { BottomDrawer } from './BottomDrawer'
import { ConfirmContent } from './ConfirmModal'
import { newWorktreeFormStyles as formStyles } from './new-worktree-form-styles'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'

type AddProjectView = 'start' | 'clone' | 'create' | 'addExisting' | 'confirmFolder'

// The host's refusal for a directory that is not a git repository; the same substring the desktop
// Add project dialog watches for to offer the folder downgrade.
const NOT_A_GIT_REPOSITORY = 'Not a valid git repository'

type AddProjectModalProps = {
  visible: boolean
  client: RpcClient | null
  onProjectAdded: (repo: MobileWorkspaceRepo) => void
  onClose: () => void
}

type AddedRepo = { id: string; path: string; displayName: string }

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
  onClose
}: AddProjectModalProps) {
  // Why: each opening is a fresh form session; remounting resets local form state before
  // paint instead of clearing it in a visible-prop Effect (same reason NewWorktreeModal
  // remounts its session).
  const [session, setSession] = useState({ openEpoch: 0, visible })
  if (session.visible !== visible) {
    setSession({
      openEpoch: visible ? session.openEpoch + 1 : session.openEpoch,
      visible
    })
  }

  // Why: the handoff must outlive the content — the drawer unmounts its children before
  // onAfterClose fires, so the pending repo lives here rather than in the form state.
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
  onAfterClose
}: {
  visible: boolean
  client: RpcClient | null
  onAdded: (repo: MobileWorkspaceRepo) => void
  onClose: () => void
  onAfterClose: () => void
}) {
  const [view, setView] = useState<AddProjectView>('start')
  const [cloneUrl, setCloneUrl] = useState('')
  const [projectName, setProjectName] = useState('')
  const [folderCandidate, setFolderCandidate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Why: a ref, not state — ConfirmContent calls onConfirm then onCancel in the same tick, so the
  // flag has to be readable before React re-renders.
  const confirmingFolderRef = useRef(false)

  const value = view === 'clone' ? cloneUrl : projectName
  const canSubmit = value.trim().length > 0 && !busy && client != null

  const submit = useCallback(() => {
    if (!canSubmit || !client) {
      return
    }
    setBusy(true)
    setError('')
    const run = async (): Promise<MobileWorkspaceRepo> => {
      if (view === 'clone') {
        const reply = repoCloneRun.interpret(
          await repoCloneRun.request(
            client,
            { url: cloneUrl.trim() },
            {
              timeoutMs: REPO_CLONE_TIMEOUT_MS
            }
          )
        )
        return toMobileRepo(reply.repo)
      }
      if (view === 'create') {
        const reply = repoCreateRun.interpret(
          await repoCreateRun.request(client, { name: projectName.trim(), kind: 'git' })
        )
        if ('error' in reply) {
          // Why: repo.create reports failures inside a successful result; raise it so the
          // same error row renders it as a thrown refusal would.
          throw new Error(reply.error || 'Failed to create the project')
        }
        return toMobileRepo(reply.repo)
      }
      throw new Error('Unsupported add project step')
    }
    run()
      .then((repo) => onAdded(repo))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => setBusy(false))
  }, [canSubmit, client, cloneUrl, onAdded, projectName, view])

  // Why: the same order the desktop dialog uses — try git, and only offer the folder downgrade
  // once the host has refused the path, so a git repository never lands in folder mode.
  const addFolder = useCallback(
    async (path: string, kind: 'git' | 'folder'): Promise<void> => {
      if (!client || busy) {
        return
      }
      setBusy(true)
      setError('')
      try {
        const reply = repoAddExistingRun.interpret(
          await repoAddExistingRun.request(client, { path, kind })
        )
        onAdded(toMobileRepo(reply.repo))
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (kind === 'git' && message.includes(NOT_A_GIT_REPOSITORY)) {
          setFolderCandidate(path)
          setView('confirmFolder')
        } else {
          // Why: back to the browser, the only step with an error row; ConfirmContent has none.
          setError(message)
          setView('addExisting')
        }
      } finally {
        setBusy(false)
      }
    },
    [busy, client, onAdded]
  )

  const content = (() => {
    if (view === 'start') {
      return (
        // No onClose: picking a row switches this sheet's content in place; closing is the
        // drawer's own drag or the area outside it.
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
              onPress: () => setView('clone')
            },
            {
              label: 'Create new project',
              icon: Plus,
              hint: 'Start from an empty folder',
              onPress: () => setView('create')
            }
          ]}
        />
      )
    }

    if (view === 'addExisting') {
      return (
        <AddProjectFolderBrowser
          client={client}
          busy={busy}
          error={error}
          onBack={() => setView('start')}
          onPick={(path) => void addFolder(path, 'git')}
        />
      )
    }

    if (view === 'confirmFolder') {
      return (
        <ConfirmContent
          title="Add as a folder project?"
          message={`${folderCandidate} is not a Git repository. Folder projects have no worktrees, source control, pull requests, or checks.`}
          confirmLabel="Add folder"
          onConfirm={() => {
            // Why: ConfirmContent also fires onCancel on confirm; hold this sheet until the add
            // settles so a success does not flash the browser first and a refusal still has a
            // place to land. addFolder's own catch is what leaves this view.
            confirmingFolderRef.current = true
            void addFolder(folderCandidate, 'folder')
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
        hint: "Cloned into the host's default projects folder. Large repositories can take a few minutes.",
        button: 'Clone repository'
      },
      create: {
        title: 'Create new project',
        label: 'Project name',
        placeholder: 'my-project',
        hint: "An empty git repository with an initial commit, created in the host's default projects folder.",
        button: 'Create project'
      }
    }[view]

    return (
      <View>
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
      contentScrollable={view !== 'addExisting'}
    >
      {content}
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.md
  },
  backButton: {
    marginLeft: -spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  hint: {
    marginTop: spacing.xs,
    fontSize: typography.metaSize,
    color: colors.textMuted
  }
})

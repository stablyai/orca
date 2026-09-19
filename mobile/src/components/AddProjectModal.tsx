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
import { BottomDrawer } from './BottomDrawer'
import { newWorktreeFormStyles as formStyles } from './new-worktree-form-styles'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'

type AddProjectView = 'start' | 'clone' | 'create' | 'addExisting'

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
 * to `onProjectAdded` — from `onAfterClose`, so the New workspace modal it opens is
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
    <BottomDrawer visible={visible} onClose={onClose} onAfterClose={fireHandoff}>
      <AddProjectModalContent
        key={session.openEpoch}
        client={client}
        onAdded={(repo) => {
          handoffRef.current = repo
          onClose()
        }}
      />
    </BottomDrawer>
  )
}

function AddProjectModalContent({
  client,
  onAdded
}: {
  client: RpcClient | null
  onAdded: (repo: MobileWorkspaceRepo) => void
}) {
  const [view, setView] = useState<AddProjectView>('start')
  const [cloneUrl, setCloneUrl] = useState('')
  const [projectName, setProjectName] = useState('')
  const [existingPath, setExistingPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const value = view === 'clone' ? cloneUrl : view === 'create' ? projectName : existingPath
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
      const reply = repoAddExistingRun.interpret(
        await repoAddExistingRun.request(client, { path: existingPath.trim() })
      )
      return toMobileRepo(reply.repo)
    }
    run()
      .then((repo) => onAdded(repo))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => setBusy(false))
  }, [canSubmit, client, cloneUrl, existingPath, onAdded, projectName, view])

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
    },
    addExisting: {
      title: 'Browse folder',
      label: 'Project path',
      placeholder: '/home/dev/my-project',
      hint: 'The absolute path of an existing git repository on this host.',
      button: 'Add project'
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
          onChangeText={
            view === 'clone' ? setCloneUrl : view === 'create' ? setProjectName : setExistingPath
          }
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

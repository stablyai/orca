import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { View, Text } from 'react-native'
import { MessageBox } from '../../components/composer-input/MessageBox'
import { TextField } from '../../components/composer-input/TextField'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SettingsNote } from '../../settings/settings-screen-frame'
import { Check, X } from 'lucide-react-native'
import { TASK_SECONDARY_DRAWER_Z_INDEX } from '../task-list/mobile-tasks-options'
import { setupSourceLabel } from '../repositories/mobile-tasks-repository-presentation'
import { LIST_LEADING_INSET, ListGroup, ListRow } from '../../components/list/ListGroup'
import { translate } from '../../i18n/mobile-i18n'
import { OrcaHookTrustDrawer } from '../../components/hook-trust/OrcaHookTrustDrawer'
import type { CreateSetupApproval } from '../../new-workspace/creation/setup-hook-trust'
import {
  createdSetupRunFailed,
  runReviewedCreatedSetup
} from '../../new-workspace/creation/created-worktree-setup-review'
import type { OrcaYamlTrustPrompt } from '../mobile-tasks-project-workspace-types'

export function renderMobileTasksWorkspaceSparseDrawer(model: ConnectionPresentationModel) {
  const {
    canSaveWorkspaceSparseDraft,
    groupFieldStyles,
    saveWorkspaceSparsePreset,
    setWorkspaceSparseDraft,
    t,
    taskUiReady,
    workspaceCreateDraft,
    workspaceSparseDraft,
    workspaceSparseDraftError,
    workspaceSparseDraftParsed,
    workspaceSparseSaving
  } = model
  const count = workspaceSparseDraftParsed?.directories.length ?? 0
  return (
    <BottomDrawer
      visible={taskUiReady && workspaceCreateDraft != null && workspaceSparseDraft != null}
      onClose={() => {
        if (!workspaceSparseSaving) {
          setWorkspaceSparseDraft(null)
        }
      }}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 2}
    >
      {workspaceSparseDraft ? (
        <View>
          <SheetHeader
            title={
              workspaceSparseDraft.mode === 'new'
                ? t('tasks.workspaceTrustDrawers.newSparsePreset', 'New Sparse Preset')
                : t('tasks.workspaceTrustDrawers.editSparsePreset', 'Edit Sparse Preset')
            }
            leading={{
              label: t('common.cancel', 'Cancel'),
              onPress: () => setWorkspaceSparseDraft(null),
              disabled: workspaceSparseSaving
            }}
            trailing={{
              label: t('common.save', 'Save'),
              onPress: () => void saveWorkspaceSparsePreset(),
              disabled: !canSaveWorkspaceSparseDraft,
              busy: workspaceSparseSaving
            }}
          />
          <ListGroup style={groupFieldStyles.underHeader}>
            <TextField
              key="name"
              value={workspaceSparseDraft.name}
              onChangeText={(name) => setWorkspaceSparseDraft({ ...workspaceSparseDraft, name })}
              placeholder={t('tasks.workspaceTrustDrawers.nameLabel', 'Name')}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={80}
              style={groupFieldStyles.line}
            />
            <MessageBox
              key="directories"
              value={workspaceSparseDraft.directoriesText}
              onChangeText={(directoriesText) =>
                setWorkspaceSparseDraft({ ...workspaceSparseDraft, directoriesText })
              }
              placeholder={'src/renderer\npackages/ui'}
              accessibilityLabel={t('tasks.workspaceTrustDrawers.directoriesLabel', 'Directories')}
              autoCapitalize="none"
              autoCorrect={false}
              monospace
              style={groupFieldStyles.lines}
            />
          </ListGroup>
          <SettingsNote error={workspaceSparseDraftError != null}>
            {workspaceSparseDraftError ??
              (count === 1
                ? t('tasks.workspaceTrustDrawers.directories_one', '{{count}} directory', {
                    count
                  })
                : t('tasks.workspaceTrustDrawers.directories_other', '{{count}} directories', {
                    count
                  }))}
          </SettingsNote>
        </View>
      ) : null}
    </BottomDrawer>
  )
}

export function renderMobileTasksSetupTrustDrawer(model: ConnectionPresentationModel) {
  const {
    colors,
    createWorkspace,
    creatingKey,
    setSetupPrompt,
    setupPrompt,
    styles,
    t,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && setupPrompt != null}
      onClose={() => setSetupPrompt(null)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
    >
      {setupPrompt ? (
        <View>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>
              {t('tasks.workspaceTrustDrawers.setupTitle', 'Run Setup Script?')}
            </Text>
            <Text style={styles.sheetSubtitle}>
              {t(
                'tasks.workspaceTrustDrawers.setupSubtitle',
                '{{name}} requires a setup choice before creating this workspace.',
                {
                  name: setupPrompt.repoName
                }
              )}
            </Text>
          </View>

          <View style={styles.setupPromptBox}>
            <View style={styles.detailSectionHeader}>
              <Text style={styles.detailSectionTitle}>{setupSourceLabel(setupPrompt.source)}</Text>
            </View>
            <Text style={styles.setupPromptCommand}>{setupPrompt.command}</Text>
          </View>

          <ListGroup separatorInset={LIST_LEADING_INSET}>
            <ListRow
              key="action-1"
              title={
                creatingKey === setupPrompt.item.key
                  ? t('tasks.workspaceTrustDrawers.creating', 'Creating...')
                  : t('tasks.workspaceTrustDrawers.runSetupAndCreate', 'Run setup and create')
              }
              leading={<Check size={16} color={colors.textPrimary} />}
              disabled={creatingKey === setupPrompt.item.key}
              onPress={() =>
                void createWorkspace(
                  setupPrompt.item,
                  setupPrompt.repoIdOverride,
                  'run',
                  setupPrompt.agentOverride,
                  setupPrompt.workspaceNameOverride,
                  setupPrompt.noteOverride,
                  setupPrompt.baseBranchOverride,
                  setupPrompt.branchNameOverride,
                  setupPrompt.sparseCheckoutOverride
                )
              }
            />
            <ListRow
              key="action-2"
              title={t('tasks.workspaceTrustDrawers.skipSetupAndCreate', 'Create without setup')}
              leading={<X size={16} color={colors.textPrimary} />}
              disabled={creatingKey === setupPrompt.item.key}
              onPress={() =>
                void createWorkspace(
                  setupPrompt.item,
                  setupPrompt.repoIdOverride,
                  'skip',
                  setupPrompt.agentOverride,
                  setupPrompt.workspaceNameOverride,
                  setupPrompt.noteOverride,
                  setupPrompt.baseBranchOverride,
                  setupPrompt.branchNameOverride,
                  setupPrompt.sparseCheckoutOverride
                )
              }
            />
          </ListGroup>
        </View>
      ) : null}
    </BottomDrawer>
  )
}

// Prompts already acted on: callbacks delivered before the busy render must not act twice.
const actedPrompts = new WeakSet<OrcaYamlTrustPrompt>()

export function renderMobileTasksOrcaYamlTrustDrawer(model: ConnectionPresentationModel) {
  const {
    client,
    createWorkspace,
    creatingKey,
    orcaYamlTrustPrompt,
    persistSetupHookTrust,
    setError,
    setOrcaYamlTrustPrompt,
    taskUiReady
  } = model
  const createWithSetup = (prompt: OrcaYamlTrustPrompt, setup?: CreateSetupApproval) =>
    createWorkspace(
      prompt.item,
      prompt.repoIdOverride,
      setup ? 'run' : 'skip',
      prompt.agentOverride,
      prompt.workspaceNameOverride,
      prompt.noteOverride,
      prompt.baseBranchOverride,
      prompt.branchNameOverride,
      prompt.sparseCheckoutOverride,
      { setup, hostedStartPoint: prompt.hostedStartPoint }
    )
  const approve = (alwaysTrust: boolean) => {
    const prompt = orcaYamlTrustPrompt
    // One choice per prompt: a second tap or a decline while this runs must not act again.
    if (!prompt || prompt.approving || actedPrompts.has(prompt)) {
      return
    }
    actedPrompts.add(prompt)
    setOrcaYamlTrustPrompt({ ...prompt, approving: true })
    void (async () => {
      let notice: string | undefined
      try {
        const setupApproval = await persistSetupHookTrust(prompt, alwaysTrust)
        if (prompt.created) {
          notice = client
            ? await runReviewedCreatedSetup(client, prompt.created.worktreeId, prompt.contentHash)
            : createdSetupRunFailed()
          return
        }
        setOrcaYamlTrustPrompt(null)
        if (setupApproval) {
          await createWithSetup(prompt, setupApproval)
        }
      } catch (err) {
        if (prompt.created) {
          notice = createdSetupRunFailed()
          return
        }
        // The prompt stays up after a failed save, so it may be approved again.
        actedPrompts.delete(prompt)
        setOrcaYamlTrustPrompt(prompt)
        setError(
          err instanceof Error
            ? err.message
            : translate('tasks.workspaceTrustDrawers.trustFailed', 'Failed to trust setup script.')
        )
      } finally {
        // The workspace exists either way; opening it ends the review and frees its item.
        if (prompt.created) {
          setOrcaYamlTrustPrompt(null)
          prompt.created.open(notice)
        }
      }
    })()
  }
  // Declining a created workspace's setup leaves it as is and opens it.
  const decline = (create: boolean) => {
    const prompt = orcaYamlTrustPrompt
    if (!prompt || prompt.approving || actedPrompts.has(prompt)) {
      return
    }
    actedPrompts.add(prompt)
    setOrcaYamlTrustPrompt(null)
    if (prompt.created) {
      prompt.created.open()
    } else if (create) {
      void createWithSetup(prompt)
    }
  }
  return (
    <OrcaHookTrustDrawer
      visible={taskUiReady && orcaYamlTrustPrompt != null}
      prompt={orcaYamlTrustPrompt}
      busy={
        orcaYamlTrustPrompt != null &&
        (orcaYamlTrustPrompt.approving === true ||
          (!orcaYamlTrustPrompt.created && creatingKey === orcaYamlTrustPrompt.item.key))
      }
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX + 1}
      onRunOnce={() => approve(false)}
      onAlwaysTrust={() => approve(true)}
      onDontRun={() => decline(true)}
      onClose={() => decline(false)}
    />
  )
}

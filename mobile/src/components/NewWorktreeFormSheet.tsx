import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'
import { ChevronDown, ChevronUp } from 'lucide-react-native'
import type { WorkspaceCreateSetupDecision } from '../tasks/workspace-create-params'
import type { WorkspaceSshGate } from '../tasks/workspace-ssh-gate'
import type { useMobileComposerSource } from '../tasks/use-mobile-composer-source'
import { colors } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'
import { MobileAgentIcon } from './MobileAgentIcon'
import type { NewWorktreeAgentOption } from './new-worktree-agent-selection'
import { newWorktreeFormStyles as styles } from './new-worktree-form-styles'
import type { SetupRunPolicy } from './new-worktree-modal-types'
import { NewWorktreeProjectTargetFields } from './NewWorktreeProjectTargetFields'
import { NewWorkspaceSetupScriptField } from './NewWorkspaceSetupScriptField'
import { NewWorkspaceSshConnectionField } from './NewWorkspaceSshConnectionField'
import { SmartWorkspaceAdvancedFields } from './SmartWorkspaceAdvancedFields'
import { SmartWorkspaceSourceField } from './SmartWorkspaceSourceField'

type Composer = ReturnType<typeof useMobileComposerSource>
type Selection = { label: string; detail?: string }

export function NewWorktreeFormSheet(props: {
  visible: boolean
  interactive: boolean
  loading: boolean
  hasRepos: boolean
  project: Selection | null
  runTarget: Selection | null
  projectBadgeColor: string | null
  selectedRepoIsGit: boolean
  selectedRepoConnectionId: string | null
  selectedRepoName: string
  sshGate: WorkspaceSshGate
  composer: Composer
  selectedAgent: NewWorktreeAgentOption
  showAdvanced: boolean
  note: string
  setupCommand: string | null
  setupSource: string | null
  setupRunPolicy: SetupRunPolicy
  setupDecisionChoice: Exclude<WorkspaceCreateSetupDecision, 'inherit'> | null
  runSetup: boolean
  error: string
  creating: boolean
  canCreate: boolean
  onClose: () => void
  onOpenProject: () => void
  onOpenRunTarget: () => void
  onOpenSource: () => void
  onClearError: () => void
  onConnect: () => void
  onOpenAgent: () => void
  onShowAdvancedChange: (show: boolean) => void
  onNoteChange: (note: string) => void
  onSetupDecisionChange: (decision: Exclude<WorkspaceCreateSetupDecision, 'inherit'>) => void
  onRunSetupChange: (run: boolean) => void
  onCreate: () => void
}) {
  return (
    <BottomDrawer visible={props.visible} interactive={props.interactive} onClose={props.onClose}>
      <View style={styles.header}>
        <Text style={styles.title}>Create worktree</Text>
      </View>

      {props.loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : !props.hasRepos ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.emptyText}>No projects found</Text>
        </View>
      ) : (
        <>
          <NewWorktreeProjectTargetFields
            project={props.project}
            runTarget={props.runTarget}
            projectBadgeColor={props.projectBadgeColor}
            onOpenProject={props.onOpenProject}
            onOpenRunTarget={props.onOpenRunTarget}
          />

          <SmartWorkspaceSourceField
            composer={props.composer}
            label={props.selectedRepoIsGit ? "Name or 'Create From'" : 'Workspace name'}
            disabled={props.sshGate.requiresConnection}
            interactive={props.interactive}
            onBeforeOpen={props.onClearError}
            onOpenDrawer={props.onOpenSource}
          />

          {props.composer.forkPushWarning ? (
            <Text style={styles.sourceWarning}>{props.composer.forkPushWarning}</Text>
          ) : null}

          {props.selectedRepoConnectionId ? (
            <NewWorkspaceSshConnectionField
              repoName={props.selectedRepoName}
              sshGate={props.sshGate}
              onConnect={props.onConnect}
            />
          ) : null}

          <View style={styles.field}>
            <Text style={styles.label}>Agent</Text>
            <Pressable
              style={[styles.fieldButton, props.sshGate.requiresConnection && styles.disabled]}
              disabled={props.sshGate.requiresConnection}
              onPress={props.onOpenAgent}
            >
              <MobileAgentIcon agentId={props.selectedAgent.id} size={16} />
              <Text style={styles.fieldButtonText} numberOfLines={1}>
                {props.sshGate.requiresConnection
                  ? 'Connect target first'
                  : props.selectedAgent.label}
              </Text>
              <ChevronDown size={14} color={colors.textMuted} />
            </Pressable>
          </View>

          <Pressable
            style={styles.advancedToggle}
            onPress={() => props.onShowAdvancedChange(!props.showAdvanced)}
          >
            <Text style={styles.advancedText}>Advanced</Text>
            {props.showAdvanced ? (
              <ChevronUp size={14} color={colors.textSecondary} />
            ) : (
              <ChevronDown size={14} color={colors.textSecondary} />
            )}
          </Pressable>

          {props.showAdvanced ? (
            <>
              <SmartWorkspaceAdvancedFields
                composer={props.composer}
                selectedRepoIsGit={props.selectedRepoIsGit}
              />
              <View style={styles.field}>
                <Text style={styles.label}>Note</Text>
                <TextInput
                  style={styles.input}
                  value={props.note}
                  onChangeText={props.onNoteChange}
                  placeholder="Write a note"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              {props.setupCommand ? (
                <NewWorkspaceSetupScriptField
                  command={props.setupCommand}
                  source={props.setupSource}
                  runPolicy={props.setupRunPolicy}
                  decision={props.setupDecisionChoice}
                  runSetup={props.runSetup}
                  onDecisionChange={props.onSetupDecisionChange}
                  onRunSetupChange={props.onRunSetupChange}
                />
              ) : null}
            </>
          ) : null}

          {props.error ? <Text style={styles.error}>{props.error}</Text> : null}
          <View style={styles.actions}>
            <Pressable
              style={[styles.createButton, !props.canCreate && styles.createButtonDisabled]}
              disabled={!props.canCreate}
              onPress={props.onCreate}
            >
              {props.creating ? (
                <ActivityIndicator size="small" color={colors.bgBase} />
              ) : (
                <Text style={styles.createText}>
                  {props.sshGate.requiresConnection ? 'Connect target' : 'Create worktree'}
                </Text>
              )}
            </Pressable>
          </View>
        </>
      )}
    </BottomDrawer>
  )
}

import { ActivityIndicator, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { WorkspaceCreateSetupDecision } from '../tasks/workspace-create-params'
import type { WorkspaceSshGate } from '../tasks/workspace-ssh-gate'
import type { useMobileComposerSource } from '../tasks/use-mobile-composer-source'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { BottomDrawer } from './BottomDrawer'
import { MobileAgentIcon } from './MobileAgentIcon'
import { LIST_LEADING_INSET, ListGroup } from './list/ListGroup'
import { ListRow } from './list/ListRow'
import { SectionHeader } from './list/SectionHeader'
import { SheetHeader } from './nav-bar/SheetHeader'
import type { NewWorktreeAgentOption } from './new-worktree-agent-selection'
import { newWorktreeFormStyles as styles } from './new-worktree-form-styles'
import type { SetupRunPolicy } from './new-worktree-modal-types'
import { NewWorktreeFormOptions } from './NewWorktreeFormOptions'
import { NewWorktreeProjectTargetFields } from './NewWorktreeProjectTargetFields'
import { NewWorkspaceSshConnectionField } from './NewWorkspaceSshConnectionField'
import { SheetPrimaryButton } from './SheetPrimaryButton'
import { SmartWorkspaceSourceField } from './SmartWorkspaceSourceField'

type Composer = ReturnType<typeof useMobileComposerSource>
type Selection = { label: string; detail?: string }

export function NewWorktreeFormSheet(props: {
  visible: boolean
  interactive: boolean
  loading: boolean
  hasRepos: boolean
  project: Selection | null
  runTarget: (Selection & { hostId: string }) | null
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
  onOpenExternalUrl: (url: string) => void
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
  useMobileColorScheme()
  const t = useMobileTranslation()
  const gated = props.sshGate.requiresConnection
  // Desktop's rule: a git project makes a worktree, a folder project a plain workspace.
  const title = props.selectedRepoIsGit
    ? t('components.newWorktreeFormSheet.createWorktree', 'Create worktree')
    : t('components.newWorktreeFormSheet.createWorkspace', 'Create workspace')
  const agentLabel = gated
    ? t('components.newWorktreeFormSheet.connectTargetFirst', 'Connect target first')
    : props.selectedAgent.label
  return (
    <BottomDrawer visible={props.visible} interactive={props.interactive} onClose={props.onClose}>
      <View style={styles.header}>
        <SheetHeader
          title={title}
          leading={{
            label: t('common.cancel', 'Cancel'),
            onPress: props.onClose,
            disabled: props.creating
          }}
        />
      </View>

      {props.loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : !props.hasRepos ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.emptyText}>
            {t('components.newWorktreeFormSheet.noProjectsFound', 'No projects found')}
          </Text>
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

          {props.selectedRepoConnectionId ? (
            <NewWorkspaceSshConnectionField
              repoName={props.selectedRepoName}
              sshGate={props.sshGate}
              onConnect={props.onConnect}
            />
          ) : null}

          <SmartWorkspaceSourceField
            composer={props.composer}
            label={
              props.selectedRepoIsGit
                ? t('components.newWorktreeFormSheet.startFrom', 'Start from')
                : t('components.newWorktreeFormSheet.workspaceName', 'Workspace name')
            }
            disabled={gated}
            interactive={props.interactive}
            onOpenExternalUrl={props.onOpenExternalUrl}
            onBeforeOpen={props.onClearError}
            onOpenDrawer={props.onOpenSource}
          />

          {props.composer.forkPushWarning ? (
            <Text style={styles.notice}>{props.composer.forkPushWarning}</Text>
          ) : null}

          <SectionHeader title={t('components.newWorktreeFormSheet.agent', 'Agent')} />
          <ListGroup separatorInset={LIST_LEADING_INSET}>
            <ListRow
              key="agent"
              title={agentLabel}
              leading={<MobileAgentIcon agentId={props.selectedAgent.id} size={20} />}
              navigates
              disabled={gated}
              onPress={props.onOpenAgent}
              accessibilityLabel={`${t('components.newWorktreeFormSheet.agent', 'Agent')}, ${agentLabel}`}
            />
          </ListGroup>

          <NewWorktreeFormOptions
            expanded={props.showAdvanced}
            composer={props.composer}
            selectedRepoIsGit={props.selectedRepoIsGit}
            note={props.note}
            setupCommand={props.setupCommand}
            setupSource={props.setupSource}
            setupRunPolicy={props.setupRunPolicy}
            setupDecisionChoice={props.setupDecisionChoice}
            runSetup={props.runSetup}
            onExpandedChange={props.onShowAdvancedChange}
            onNoteChange={props.onNoteChange}
            onSetupDecisionChange={props.onSetupDecisionChange}
            onRunSetupChange={props.onRunSetupChange}
          />

          {props.error ? <Text style={styles.error}>{props.error}</Text> : null}
          <View style={styles.footer}>
            <SheetPrimaryButton
              label={
                gated ? t('components.newWorktreeFormSheet.connectTarget', 'Connect target') : title
              }
              busy={props.creating}
              disabled={!props.canCreate}
              onPress={props.onCreate}
            />
          </View>
        </>
      )}
    </BottomDrawer>
  )
}

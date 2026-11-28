import { Text, View } from 'react-native'
import { FolderGit2 } from 'lucide-react-native'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { SetupDecision as WorkspaceCreateSetupDecision } from '../../../../../src/shared/worktree/create-types'
import type { WorkspaceSshGate } from '../workspace-ssh-gate'
import type { useMobileComposerSource } from '../../source-selection/use-mobile-composer-source'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { MobileLoadErrorState, MobileStateView } from '../../../components/feedback/MobileStateView'
import { MobileAgentIcon } from '../../../components/icons/MobileAgentIcon'
import {
  LIST_LEADING_INSET,
  ListGroup,
  SectionHeader,
  ListRow
} from '../../../components/list/ListGroup'
import { SheetHeader } from '../../../components/nav-bar/SheetHeader'
import type { NewWorktreeAgentOption } from '../runtime/new-worktree-agent-selection'
import { newWorktreeFormStylesSheet } from './new-worktree-form-styles'
import type { SetupRunPolicy } from './new-worktree-modal-types'
import { NewWorktreeFormOptions } from './NewWorktreeFormOptions'
import { NewWorktreeProjectTargetFields } from './NewWorktreeProjectTargetFields'
import { NewWorkspaceSshConnectionField } from './NewWorkspaceSshConnectionField'
import { SheetPrimaryButton } from '../../../components/sheets/SheetPrimaryButton'
import { SmartWorkspaceSourceField } from '../../source-selection/presentation/SmartWorkspaceSourceField'
import { useThemedStyles } from '../../../theme/themed-styles'

type Composer = ReturnType<typeof useMobileComposerSource>
type Selection = { label: string; detail?: string }

export function NewWorktreeFormSheet(props: {
  visible: boolean
  interactive: boolean
  loading: boolean
  hasRepos: boolean
  loadError: string | null
  onRetryLoad: () => void
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
  waitForSetup: boolean | null
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
  onWaitForSetupChange: (wait: boolean) => void
  onCreate: () => void
}) {
  const styles = useThemedStyles(newWorktreeFormStylesSheet)
  const t = useMobileTranslation()
  const gated = props.sshGate.requiresConnection
  // One name with the + that opens it; the project row says whether it makes a worktree.
  const title = t('components.newWorktreeFormSheet.newWorkspace', 'New workspace')
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
        <View style={styles.formPlaceholder}>
          <MobileStateView
            loading
            title={t('components.newWorktreeFormSheet.loadingProjects', 'Loading projects…')}
          />
        </View>
      ) : props.loadError !== null ? (
        <View style={styles.formPlaceholder}>
          <MobileLoadErrorState error={props.loadError} onRetry={props.onRetryLoad} />
        </View>
      ) : !props.hasRepos ? (
        <MobileStateView
          icon={FolderGit2}
          title={t('components.newWorktreeFormSheet.noProjectsFound', 'No projects found')}
        />
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
            waitForSetup={props.waitForSetup}
            onExpandedChange={props.onShowAdvancedChange}
            onNoteChange={props.onNoteChange}
            onSetupDecisionChange={props.onSetupDecisionChange}
            onRunSetupChange={props.onRunSetupChange}
            onWaitForSetupChange={props.onWaitForSetupChange}
          />

          {props.error ? <Text style={styles.error}>{props.error}</Text> : null}
          <View style={styles.footer}>
            <SheetPrimaryButton
              label={
                gated
                  ? t('components.newWorktreeFormSheet.connectTarget', 'Connect target')
                  : t('components.newWorktreeFormSheet.create', 'Create')
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

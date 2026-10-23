import { View } from 'react-native'
import { FolderPlus } from 'lucide-react-native'
import type { WorkspaceCreateSetupDecision } from '../tasks/workspace-create-params'
import type { WorkspaceSshGate } from '../tasks/workspace-ssh-gate'
import type { useMobileComposerSource } from '../tasks/use-mobile-composer-source'
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
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'
import { Collapsible } from './ui/Collapsible'
import { LIST_LEADING_INSET, ListGroup } from './ui/ListGroup'
import { ListRow } from './ui/ListRow'
import { SectionHeader } from './ui/SectionHeader'
import { SheetHeader } from './ui/SheetHeader'
import { StateView } from './ui/StateView'
import { TextField } from './ui/TextField'

type Composer = ReturnType<typeof useMobileComposerSource>
type Selection = { label: string; detail?: string }

/** Desktop's rule: a git project makes a worktree, a folder project a plain workspace. */
function createLabel(selectedRepoIsGit: boolean): string {
  return selectedRepoIsGit ? 'Create worktree' : 'Create workspace'
}

export function NewWorktreeFormSheet(props: {
  visible: boolean
  interactive: boolean
  loading: boolean
  /** No connection to the desktop yet, so the loader names that stage instead of the repo list. */
  connecting: boolean
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
  const title = createLabel(props.selectedRepoIsGit)
  const gated = props.sshGate.requiresConnection
  const setupField = props.setupCommand ? (
    <NewWorkspaceSetupScriptField
      command={props.setupCommand}
      source={props.setupSource}
      runPolicy={props.setupRunPolicy}
      decision={props.setupDecisionChoice}
      runSetup={props.runSetup}
      onDecisionChange={props.onSetupDecisionChange}
      onRunSetupChange={props.onRunSetupChange}
    />
  ) : null
  // An "ask" policy blocks Create until answered, so it never hides under a collapsed Options.
  const setupBlocks = props.setupRunPolicy === 'ask'

  return (
    <BottomDrawer visible={props.visible} interactive={props.interactive} onClose={props.onClose}>
      <View style={styles.header}>
        <SheetHeader
          title={title}
          leading={{ label: 'Cancel', onPress: props.onClose, disabled: props.creating }}
        />
      </View>

      {props.loading ? (
        <View style={styles.state}>
          <StateView
            loading
            title={props.connecting ? 'Connecting to your desktop…' : 'Loading projects…'}
          />
        </View>
      ) : !props.hasRepos ? (
        <View style={styles.state}>
          <StateView
            icon={FolderPlus}
            title="No projects yet"
            message="Add a project on your desktop, then create workspaces for it here."
          />
        </View>
      ) : (
        <>
          {/* Why: once Create is pressed the form is what is being created; edits would be lost. */}
          <View pointerEvents={props.creating ? 'none' : 'auto'}>
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
              label={props.selectedRepoIsGit ? 'Start from' : 'Workspace name'}
              disabled={gated}
              interactive={props.interactive}
              onOpenExternalUrl={props.onOpenExternalUrl}
              onBeforeOpen={props.onClearError}
              onOpenDrawer={props.onOpenSource}
            />

            {props.composer.forkPushWarning ? (
              <View style={[styles.bleed, styles.bannerGap]}>
                <Banner tone="warning" message={props.composer.forkPushWarning} />
              </View>
            ) : null}

            <View style={styles.bleed}>
              <SectionHeader title="Agent" />
            </View>
            <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.group}>
              <ListRow
                title={gated ? 'Connect first' : props.selectedAgent.label}
                leading={<MobileAgentIcon agentId={props.selectedAgent.id} size={20} />}
                navigates
                disabled={gated}
                onPress={props.onOpenAgent}
                accessibilityLabel={`Agent, ${props.selectedAgent.label}`}
              />
            </ListGroup>

            {setupBlocks ? setupField : null}

            <View style={styles.bleed}>
              <SectionHeader
                title="Options"
                expanded={props.showAdvanced}
                onToggle={() => props.onShowAdvancedChange(!props.showAdvanced)}
              />
            </View>
            {/* Bled out and padded back, so the clipping frame keeps the setup field's bleeds. */}
            <View style={styles.bleed}>
              <Collapsible open={props.showAdvanced}>
                <View style={styles.unbleed}>
                  <View style={styles.stack}>
                    <SmartWorkspaceAdvancedFields
                      composer={props.composer}
                      selectedRepoIsGit={props.selectedRepoIsGit}
                    />
                    <TextField
                      label="Note"
                      value={props.note}
                      onChangeText={props.onNoteChange}
                      placeholder="Write a note"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                  {setupBlocks ? null : setupField}
                </View>
              </Collapsible>
            </View>
          </View>

          {props.error ? (
            <View style={[styles.bleed, styles.errorGap]}>
              <Banner tone="error" message={props.error} onDismiss={props.onClearError} />
            </View>
          ) : null}
          <View style={styles.footer}>
            <Button
              label={title}
              variant="primary"
              block
              busy={props.creating}
              disabled={!props.canCreate && !props.creating}
              onPress={props.onCreate}
              accessibilityHint={gated ? 'Connect the SSH target first.' : undefined}
            />
          </View>
        </>
      )}
    </BottomDrawer>
  )
}

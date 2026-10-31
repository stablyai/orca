import { View } from 'react-native'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { SmartModeAvailabilityInput } from '../tasks/mobile-smart-source-modes'
import type { PasteRepoCandidate } from '../tasks/smart-source-paste-intent'
import type { useMobileComposerSource } from '../tasks/use-mobile-composer-source'
import { HostKindIcon } from './HostKindIcon'
import { MobileAgentIcon } from './MobileAgentIcon'
import type { NewWorktreeAgentOption } from './new-worktree-agent-selection'
import { newWorktreeFormStyles as styles } from './new-worktree-form-styles'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'
import type {
  NewWorkspaceProjectOption,
  NewWorkspaceRunTargetOption
} from './new-workspace-project-targets'
import { getMobileWorkspaceRepoBadgeColor } from './new-worktree-modal-types'
import { PickerListDrawer } from './PickerListDrawer'
import { SetupHookTrustDrawer, type SetupTrustPrompt } from './SetupHookTrustDrawer'
import { SmartWorkspaceSourceDrawer } from './SmartWorkspaceSourceDrawer'
import type { JiraSite, JiraSiteSelection } from '../../../src/shared/jira/jira-types'
import type { NewWorktreeDrawerView } from './use-new-worktree-drawer-navigation'

type Composer = ReturnType<typeof useMobileComposerSource>

export function NewWorktreeModalDrawers(props: {
  visible: boolean
  drawerView: NewWorktreeDrawerView
  client: Parameters<typeof SmartWorkspaceSourceDrawer>[0]['client']
  composer: Composer
  sourceAvailability: SmartModeAvailabilityInput
  selectedRepo: MobileWorkspaceRepo | null
  /** The picked repo's host's repos: a source can switch repos only within that host. */
  repos: MobileWorkspaceRepo[]
  pasteRepos: PasteRepoCandidate[]
  jiraSiteId: JiraSiteSelection | null
  jiraSites: readonly JiraSite[]
  sshReady: boolean
  projectPickerItems: NewWorkspaceProjectOption<MobileWorkspaceRepo>[]
  selectedProjectId: string | null
  runTargetPickerItems: NewWorkspaceRunTargetOption<MobileWorkspaceRepo>[]
  pickerAgentOptions: NewWorktreeAgentOption[]
  selectedAgent: NewWorktreeAgentOption
  setupTrustPrompt: SetupTrustPrompt | null
  creating: boolean
  onSourceRepoChange: (repo: MobileWorkspaceRepo) => void
  onRepoChange: (repo: MobileWorkspaceRepo) => void
  onAgentChange: (agent: NewWorktreeAgentOption) => void
  onTransitionToForm: () => void
  onApproveSetupTrust: (alwaysTrust: boolean) => void
  onSkipSetupTrust: () => void
  onCloseSetupTrust: () => void
}) {
  const t = useMobileTranslation()
  return (
    <>
      <SmartWorkspaceSourceDrawer
        visible={props.visible && props.drawerView === 'source'}
        client={props.client}
        composer={props.composer}
        availability={props.sourceAvailability}
        repoId={props.selectedRepo?.id ?? null}
        repos={props.pasteRepos}
        jiraSiteId={props.jiraSiteId}
        jiraSites={props.jiraSites}
        sshReady={props.sshReady}
        onRepoChange={(repoId) => {
          const nextRepo = props.repos.find((repo) => repo.id === repoId)
          if (nextRepo) {
            props.onSourceRepoChange(nextRepo)
          }
        }}
        onClose={props.onTransitionToForm}
      />

      <PickerListDrawer
        visible={props.visible && props.drawerView === 'project'}
        title={t('components.newWorktreeModalDrawers.project', 'Project')}
        items={props.projectPickerItems}
        selectedId={props.selectedProjectId ?? ''}
        onSelect={(item) => props.onRepoChange(item.repo)}
        onClose={props.onTransitionToForm}
        renderIcon={(item) => (
          <View
            style={[
              styles.repoDot,
              { backgroundColor: getMobileWorkspaceRepoBadgeColor(item.repo) }
            ]}
          />
        )}
      />

      <PickerListDrawer
        visible={props.visible && props.drawerView === 'runTarget'}
        title={t('components.newWorktreeModalDrawers.runOn', 'Run on')}
        items={props.runTargetPickerItems}
        selectedId={props.selectedRepo ? getRepoExecutionHostId(props.selectedRepo) : ''}
        onSelect={(item) => props.onRepoChange(item.repo)}
        onClose={props.onTransitionToForm}
        renderIcon={(item) => <HostKindIcon hostId={item.hostId} size={18} />}
      />

      <PickerListDrawer
        visible={props.visible && props.drawerView === 'agent'}
        title={t('components.newWorktreeModalDrawers.agent', 'Agent')}
        items={props.pickerAgentOptions}
        selectedId={props.selectedAgent.id}
        onSelect={props.onAgentChange}
        onClose={props.onTransitionToForm}
        renderIcon={(agent) => <MobileAgentIcon agentId={agent.id} size={20} />}
      />

      <SetupHookTrustDrawer
        visible={props.visible && props.drawerView === 'trust' && props.setupTrustPrompt != null}
        prompt={props.setupTrustPrompt}
        busy={props.creating}
        onRunOnce={() => props.onApproveSetupTrust(false)}
        onAlwaysTrust={() => props.onApproveSetupTrust(true)}
        onDontRun={props.onSkipSetupTrust}
        onClose={props.onCloseSetupTrust}
      />
    </>
  )
}

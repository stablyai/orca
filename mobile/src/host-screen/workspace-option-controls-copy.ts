import * as viewOptions from '../../../src/shared/workspace-view/workspace-view-options'
import type { WorkspaceViewChoice } from '../../../src/shared/workspace-view/workspace-view-options'
import type { WorktreeCardProperty } from '../../../src/shared/ui-chrome-types'
import type { Translate } from '../i18n/mobile-i18n'
import { phoneCardPropertyChoices } from './phone-card-property-choices'
import type { HostScreenController } from './use-host-screen-controller'

function workspaceOptionChoices<Id extends string>(
  choices: readonly WorkspaceViewChoice<Id>[],
  labels: Record<Id, string>,
  descriptions: Partial<Record<Id, string>> = {}
): WorkspaceViewChoice<Id>[] {
  return choices.map((choice) => ({
    ...choice,
    label: labels[choice.id],
    description: descriptions[choice.id] ?? choice.description
  }))
}

export const groupByChoices = (t: Translate) =>
  workspaceOptionChoices(viewOptions.WORKSPACE_GROUP_BY_CHOICES, {
    none: t('hostScreen.workspaceOptionControls.none', 'None'),
    'workspace-status': t('hostScreen.workspaceOptionControls.status', 'Status'),
    'pr-status': t('hostScreen.workspaceOptionControls.pr', 'PR'),
    repo: t('hostScreen.workspaceOptionControls.project', 'Project')
  })

export const sortByChoices = (t: Translate) =>
  workspaceOptionChoices(
    viewOptions.WORKSPACE_SORT_BY_CHOICES,
    {
      name: t('hostScreen.workspaceOptionControls.name', 'Name'),
      smart: t('hostScreen.workspaceOptionControls.agentActivitySort', 'Agent Activity'),
      recent: t('hostScreen.workspaceOptionControls.recent', 'Recent'),
      repo: t('hostScreen.workspaceOptionControls.project', 'Project'),
      manual: t('hostScreen.workspaceOptionControls.manual', 'Manual')
    },
    {
      smart: t(
        'hostScreen.workspaceOptionControls.agentActivitySortDescription',
        'Agents that need attention, then most recent activity.'
      ),
      manual: t(
        'hostScreen.workspaceOptionControls.manualWorkspaceOrderDescription',
        'Drag workspaces to arrange them within each group.'
      )
    }
  )

export const projectOrderChoices = (t: Translate) =>
  workspaceOptionChoices(
    viewOptions.WORKSPACE_PROJECT_ORDER_CHOICES,
    {
      manual: t('hostScreen.workspaceOptionControls.manual', 'Manual'),
      recent: t('hostScreen.workspaceOptionControls.recent', 'Recent')
    },
    {
      manual: t(
        'hostScreen.workspaceOptionControls.manualProjectOrderDescription',
        'Drag projects to arrange them'
      ),
      recent: t(
        'hostScreen.workspaceOptionControls.recentProjectOrderDescription',
        'Most recent workspace activity'
      )
    }
  )

export const cardLayoutChoices = (t: Translate) =>
  workspaceOptionChoices(viewOptions.WORKSPACE_CARD_LAYOUT_CHOICES, {
    detailed: t('hostScreen.workspaceOptionControls.detailed', 'Detailed'),
    compact: t('hostScreen.workspaceOptionControls.compact', 'Compact')
  })

export const activityLayoutChoices = (t: Translate) =>
  workspaceOptionChoices(viewOptions.WORKSPACE_AGENT_ACTIVITY_LAYOUT_CHOICES, {
    compact: t('hostScreen.workspaceOptionControls.compact', 'Compact'),
    full: t('hostScreen.workspaceOptionControls.fullList', 'Full list')
  })

export const cardPropertyChoices = (t: Translate) =>
  phoneCardPropertyChoices(
    workspaceOptionChoices(viewOptions.WORKSPACE_CARD_PROPERTY_CHOICES, {
      issue: t('hostScreen.workspaceOptionControls.githubTicket', 'GitHub ticket'),
      'linear-issue': t('hostScreen.workspaceOptionControls.linearIssue', 'Linear issue'),
      'jira-issue': t('hostScreen.workspaceOptionControls.jiraIssue', 'Jira issue'),
      pr: t('hostScreen.workspaceOptionControls.prMrLink', 'PR/MR link'),
      automation: t('hostScreen.workspaceOptionControls.automation', 'Automation'),
      comment: t('hostScreen.workspaceOptionControls.notes', 'Notes'),
      ports: t('hostScreen.workspaceOptionControls.ports', 'Ports'),
      'inline-agents': t('hostScreen.workspaceOptionControls.agentActivity', 'Agent activity'),
      host: t('hostScreen.workspaceOptionControls.host', 'Host')
    })
  )

// Infer project-group availability from folder rows: hosts list folder workspaces only under a group.
export function cardDisplayChoices(
  controller: HostScreenController,
  t: Translate
): WorkspaceViewChoice<WorktreeCardProperty>[] {
  const hasProjectGroups = controller.state.worktrees.some(
    (row) => row.workspaceKind === 'folder-workspace'
  )
  return phoneCardPropertyChoices(
    workspaceOptionChoices(viewOptions.WORKSPACE_CARD_DISPLAY_CHOICES, {
      issue: t('hostScreen.workspaceOptionControls.githubIssues', 'GitHub issues'),
      'linear-issue': t('hostScreen.workspaceOptionControls.linearIssues', 'Linear issues'),
      'jira-issue': t('hostScreen.workspaceOptionControls.jiraIssues', 'Jira issues'),
      comment: t('hostScreen.workspaceOptionControls.notes', 'Notes'),
      automation: t('hostScreen.workspaceOptionControls.automation', 'Automation'),
      cli: 'Orca CLI',
      ports: t('hostScreen.workspaceOptionControls.ports', 'Ports'),
      'inline-agents': t('hostScreen.workspaceOptionControls.agentStatuses', 'Agent statuses'),
      host: t('hostScreen.workspaceOptionControls.host', 'Host'),
      branch: hasProjectGroups
        ? t('hostScreen.workspaceOptionControls.branchFolderPath', 'Branch / folder path')
        : t('hostScreen.workspaceOptionControls.branchName', 'Branch name')
    })
  )
}

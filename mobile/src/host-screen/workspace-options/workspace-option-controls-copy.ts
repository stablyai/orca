import * as viewOptions from '../../../../src/shared/workspace-view/workspace-view-options'
import type { WorkspaceViewChoice } from '../../../../src/shared/workspace-view/workspace-view-options'
import type { Translate } from '../../i18n/mobile-i18n'

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

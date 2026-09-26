import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'

type DrawerLayer = {
  open: boolean
  dismiss: () => void
}

/**
 * Follow-up sheets first. iOS drops a second native modal presented while the
 * issue detail modal is still up, so every tasks sheet shares one host and
 * the back button closes only the top sheet (#21003).
 */
function mobileTasksDrawerLayers(model: ConnectionPresentationModel): DrawerLayer[] {
  const ready = model.taskUiReady
  const creating = model.workspaceCreateDraft != null
  return [
    {
      open: ready && model.pendingHostedStateChange != null,
      dismiss: () => model.setPendingHostedStateChange(null)
    },
    {
      open: ready && model.pendingProjectGitHubMerge != null,
      dismiss: () => model.setPendingProjectGitHubMerge(null)
    },
    {
      open: ready && model.pendingHostedMerge != null,
      dismiss: () => model.setPendingHostedMerge(null)
    },
    {
      open: ready && model.mergeMethodProjectRow != null,
      dismiss: () => model.setMergeMethodProjectRow(null)
    },
    {
      open: ready && model.mergeMethodTaskItem != null,
      dismiss: () => model.setMergeMethodTaskItem(null)
    },
    {
      open: ready && creating && model.workspaceSparseDraft != null,
      dismiss: () => {
        if (!model.workspaceSparseSaving) {
          model.setWorkspaceSparseDraft(null)
        }
      }
    },
    {
      open: ready && model.orcaYamlTrustPrompt != null,
      dismiss: () => model.setOrcaYamlTrustPrompt(null)
    },
    {
      open: ready && model.setupPrompt != null,
      dismiss: () => model.setSetupPrompt(null)
    },
    {
      open: ready && creating && model.showWorkspaceAgentPicker,
      dismiss: () => model.setShowWorkspaceAgentPicker(false)
    },
    {
      open: ready && creating && model.showWorkspaceCreateRepoPicker,
      dismiss: () => model.setShowWorkspaceCreateRepoPicker(false)
    },
    {
      open: ready && creating && model.showWorkspaceBaseBranchPicker,
      dismiss: () => model.setShowWorkspaceBaseBranchPicker(false)
    },
    {
      open: ready && creating && model.showWorkspaceSparsePicker,
      dismiss: () => model.setShowWorkspaceSparsePicker(false)
    },
    {
      open: ready && model.showCreateTask && model.showCreateTargetPicker,
      dismiss: () => model.setShowCreateTargetPicker(false)
    },
    {
      open: ready && model.workspaceRepoPickerItem != null,
      dismiss: () => model.setWorkspaceRepoPickerItem(null)
    },
    {
      open: ready && model.linearStatusPickerItem != null,
      dismiss: () => model.setLinearStatusPickerItem(null)
    },
    {
      open: ready && model.showGitHubProjectFieldsPicker,
      dismiss: () => model.setShowGitHubProjectFieldsPicker(false)
    },
    {
      open: ready && model.showGitHubProjectViewPicker,
      dismiss: () => {
        model.setShowGitHubProjectViewPicker(false)
        if (model.pendingGitHubProjectViewSelection) {
          model.setPendingGitHubProjectViewSelection(null)
        }
      }
    },
    {
      open: ready && model.showGitHubProjectSortPicker,
      dismiss: () => model.setShowGitHubProjectSortPicker(false)
    },
    {
      open: ready && model.showGitHubProjectPicker,
      dismiss: () => model.setShowGitHubProjectPicker(false)
    },
    {
      open: ready && model.showGitLabViewPicker,
      dismiss: () => model.setShowGitLabViewPicker(false)
    },
    {
      open: ready && model.showGitLabFilterPicker,
      dismiss: () => model.setShowGitLabFilterPicker(false)
    },
    {
      open: ready && model.showLinearFilterPicker,
      dismiss: () => model.setShowLinearFilterPicker(false)
    },
    {
      open: ready && model.showLinearWorkspacePicker,
      dismiss: () => model.setShowLinearWorkspacePicker(false)
    },
    {
      open: ready && model.showLinearTeamPicker,
      dismiss: () => model.setShowLinearTeamPicker(false)
    },
    {
      open: ready && model.showLinearViewPicker,
      dismiss: () => model.setShowLinearViewPicker(false)
    },
    {
      open: ready && model.showLinearGroupPicker,
      dismiss: () => model.setShowLinearGroupPicker(false)
    },
    {
      open: ready && model.showLinearOrderPicker,
      dismiss: () => model.setShowLinearOrderPicker(false)
    },
    {
      open: ready && model.showLinearDisplayPicker,
      dismiss: () => model.setShowLinearDisplayPicker(false)
    },
    {
      open: ready && model.showSortPicker,
      dismiss: () => model.setShowSortPicker(false)
    },
    {
      open: ready && model.showProviderPicker,
      dismiss: () => model.setShowProviderPicker(false)
    },
    {
      open: ready && model.showRepoPicker,
      dismiss: () => model.setShowRepoPicker(false)
    },
    {
      open: ready && model.showGitHubIssueSourcePicker,
      dismiss: () => model.setShowGitHubIssueSourcePicker(false)
    },
    {
      open: ready && model.showGitHubKindPicker,
      dismiss: () => model.setShowGitHubKindPicker(false)
    },
    {
      open: ready && model.showGitHubPresetPicker,
      dismiss: () => model.setShowGitHubPresetPicker(false)
    },
    {
      open: ready && model.showGitHubPagePicker,
      dismiss: () => model.setShowGitHubPagePicker(false)
    },
    {
      open: ready && creating,
      dismiss: () => model.setWorkspaceCreateDraft(null)
    },
    {
      open: ready && model.showCreateTask,
      dismiss: () => {
        model.setShowCreateTargetPicker(false)
        model.setShowCreateTask(false)
      }
    },
    {
      open: ready && model.showLinearConnect,
      dismiss: () => {
        if (model.linearConnectState !== 'connecting') {
          model.setShowLinearConnect(false)
        }
      }
    },
    {
      open: ready && model.actionItem != null,
      dismiss: () => model.setActionItem(null)
    },
    {
      open: ready && model.projectRowItem != null,
      dismiss: () => model.setProjectRowItem(null)
    },
    {
      open: ready && model.projectRepoNotInOrca != null,
      dismiss: () => model.setProjectRepoNotInOrca(null)
    }
  ]
}

export function mobileTasksOpenDrawerCount(model: ConnectionPresentationModel): number {
  let open = 0
  for (const layer of mobileTasksDrawerLayers(model)) {
    if (layer.open) {
      open += 1
    }
  }
  return open
}

export function mobileTasksDrawerHostOpen(model: ConnectionPresentationModel): boolean {
  return mobileTasksOpenDrawerCount(model) > 0
}

export function dismissTopMobileTasksDrawer(model: ConnectionPresentationModel): void {
  mobileTasksDrawerLayers(model)
    .find((layer) => layer.open)
    ?.dismiss()
}

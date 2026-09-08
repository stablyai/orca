import { describe, expect, it } from 'vitest'
import { readMobileTasksSourceFamily } from './mobile-tasks-source-family.test-support'

const tasksSource = readMobileTasksSourceFamily()

/** Every host call the Tasks composition makes goes through a typed operations
 *  object; the RPC method names live only in the adapter modules. */
const HOST_RPC_METHODS = [
  'github.addIssueComment',
  'github.addPRReviewComment',
  'github.addPRReviewCommentReply',
  'github.countWorkItems',
  'github.createIssue',
  'github.listAssignableUsers',
  'github.listLabels',
  'github.listWorkItems',
  'github.mergePR',
  'github.prChecks',
  'github.prFileContents',
  'github.project.listAccessible',
  'github.project.listAssignableUsersBySlug',
  'github.project.listIssueTypesBySlug',
  'github.project.listLabelsBySlug',
  'github.project.listViews',
  'github.project.resolveRef',
  'github.project.viewTable',
  'github.project.workItemDetailsBySlug',
  'github.repoSlug',
  'github.requestPRReviewers',
  'github.rerunPRChecks',
  'github.resolveReviewThread',
  'github.setPRFileViewed',
  'github.updateIssue',
  'github.updatePR',
  'github.updatePRState',
  'github.workItemDetails',
  'gitlab.addIssueComment',
  'gitlab.addMRComment',
  'gitlab.createIssue',
  'gitlab.listWorkItems',
  'gitlab.mergeMR',
  'gitlab.todos',
  'gitlab.updateIssue',
  'gitlab.updateMR',
  'gitlab.updateMRState',
  'gitlab.workItemDetails',
  'linear.addIssueComment',
  'linear.connect',
  'linear.createIssue',
  'linear.getIssue',
  'linear.issueComments',
  'linear.listIssues',
  'linear.listTeams',
  'linear.searchIssues',
  'linear.selectWorkspace',
  'linear.status',
  'linear.teamStates',
  'linear.updateIssue',
  'preflight.detectAgents',
  'preflight.detectRemoteAgents',
  'repo.hooks',
  'repo.list',
  'repo.searchRefs',
  'repo.update',
  'settings.update',
  'ssh.connect',
  'ssh.getState',
  'status.get',
  'ui.set'
] as const

const OPERATION_CALLS = [
  'taskReadOperations.bootstrap()',
  'taskPreferenceOperations.updateSettings(',
  'taskItemMutationOperations.setClosed(',
  'taskItemMutationOperations.updateMetadata(',
  'taskItemReviewOperations.addComment(',
  'taskItemReviewOperations.requestReviewers(',
  'taskItemReviewOperations.resolveThread(',
  'taskItemReviewOperations.replyReviewComment(',
  'taskItemReviewOperations.merge(',
  'taskItemFileOperations.refreshChecks(',
  'taskItemFileOperations.rerunChecks(',
  'taskItemFileOperations.setFileViewed(',
  'taskItemFileOperations.loadFileContents(',
  'taskItemFileOperations.addInlineComment(',
  'taskLinearOperations.updateState(',
  'taskLinearOperations.addComment(',
  'taskLinearOperations.createSubIssue(',
  'taskLinearOperations.createIssue(',
  'taskProviderWriteOperations.createIssue(',
  'taskProviderWriteOperations.updateIssueSource(',
  '.listSparsePresets(',
  '.saveSparsePreset(',
  'taskWorkspaceCreationOperations.readRuntimeSettings()',
  'taskWorkspaceCreationOperations.resolvePrBase(',
  'taskWorkspaceCreationOperations.resolveMrBase(',
  '.createWorkspaceFromSource('
] as const

describe('mobile tasks host operations', () => {
  it('keeps bootstrap and preferences behind injectable typed boundaries', () => {
    for (const call of OPERATION_CALLS) {
      expect(tasksSource, `${call} must stay wired`).toContain(call)
    }
  })

  it('leaves every raw RPC call to the adapter layer', () => {
    expect(tasksSource).not.toContain('.sendRequest(')
    for (const method of HOST_RPC_METHODS) {
      expect(tasksSource, `${method} must not be named outside the adapters`).not.toContain(
        `'${method}'`
      )
    }
  })
})

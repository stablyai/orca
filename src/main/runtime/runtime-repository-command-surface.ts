import type { RuntimeGitHubRepositoryQueryCommands } from './runtime-github-repository-query-commands'
import type { RuntimeHostedReviewCommands } from './runtime-hosted-review-commands'
import type { RuntimeNestedRepoImport } from './runtime-nested-repo-import'
import type { RuntimeProjectGroupController } from './runtime-project-group-controller'
import type { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'
import type { RuntimeRepositoryCloneController } from './runtime-repository-clone-controller'
import type { RuntimeRepositoryHooksCommands } from './runtime-repository-hooks-commands'
import type { RuntimeRepositoryIssueCommand } from './runtime-repository-issue-command'
import type { RuntimeRepositoryRefQueries } from './runtime-repository-ref-queries'
import type { RuntimeRepositoryRegistrationController } from './runtime-repository-registration-controller'
import type { RuntimeRepositorySettingsController } from './runtime-repository-settings-controller'
import type { RuntimeRepositorySparsePresets } from './runtime-repository-sparse-presets'
import type { RuntimeServerEnvironmentCommands } from './runtime-server-environment-commands'

type HostedReviewCommandName =
  | 'getRepoSlug'
  | 'getRepoUpstream'
  | 'getRepoPRForBranch'
  | 'getHostedReviewForBranch'
  | 'getHostedReviewCreationEligibility'
  | 'createHostedReview'
  | 'createStackedHostedReview'
type GitHubRepositoryQueryCommandName =
  | 'listRepoWorkItems'
  | 'listRepoIssues'
  | 'getRepoWorkItem'
  | 'getRepoWorkItemByOwnerRepo'
  | 'getRepoWorkItemDetails'
  | 'countRepoWorkItems'
  | 'listRepoLabels'
  | 'listRepoAssignableUsers'
  | 'getGitHubRateLimit'

export type RuntimeRepositoryCommandSurface = {
  listProjects: RuntimeProjectHostSetupController['listProjects']
  updateProject: RuntimeProjectHostSetupController['updateProject']
  listProjectHostSetups: RuntimeProjectHostSetupController['listSetups']
  createProjectHostSetup: RuntimeProjectHostSetupController['createSetup']
  setupProjectExistingFolder: RuntimeProjectHostSetupController['setupExistingFolder']
  setupProjectClone: RuntimeProjectHostSetupController['setupClone']
  updateProjectHostSetup: RuntimeProjectHostSetupController['updateSetup']
  deleteProjectHostSetup: RuntimeProjectHostSetupController['deleteSetup']
  listProjectGroups: RuntimeProjectGroupController['listGroups']
  listFolderWorkspaces: RuntimeProjectGroupController['listFolderWorkspaces']
  createProjectGroup: RuntimeProjectGroupController['createGroup']
  updateProjectGroup: RuntimeProjectGroupController['updateGroup']
  deleteProjectGroup: RuntimeProjectGroupController['deleteGroup']
  moveProjectToGroup: RuntimeProjectGroupController['moveProject']
  createFolderWorkspace: RuntimeProjectGroupController['createFolderWorkspace']
  getFolderWorkspacePathStatus: RuntimeProjectGroupController['getFolderPathStatus']
  updateFolderWorkspace: RuntimeProjectGroupController['updateFolderWorkspace']
  deleteFolderWorkspace: RuntimeProjectGroupController['deleteFolderWorkspace']
  scanNestedRepos: RuntimeNestedRepoImport['scan']
  importNestedRepos: RuntimeNestedRepoImport['import']
  browseServerDir: RuntimeServerEnvironmentCommands['browseDirectory']
  isGitAvailable: RuntimeServerEnvironmentCommands['isGitAvailable']
  listSparsePresets: RuntimeRepositorySparsePresets['list']
  saveSparsePreset: RuntimeRepositorySparsePresets['save']
  addRepo: RuntimeRepositoryRegistrationController['add']
  createRepo: RuntimeRepositoryRegistrationController['create']
  cloneRepo: RuntimeRepositoryCloneController['clone']
  showRepo: RuntimeRepositorySettingsController['show']
  setRepoBaseRef: RuntimeRepositorySettingsController['setBaseRef']
  updateRepo: RuntimeRepositorySettingsController['update']
  removeProject: RuntimeRepositorySettingsController['remove']
  reorderRepos: RuntimeRepositorySettingsController['reorder']
  getRepoBaseRefDefault: RuntimeRepositoryRefQueries['getDefault']
  getRepoHooks: RuntimeRepositoryHooksCommands['getRepoHooks']
  checkRepoHooks: RuntimeRepositoryHooksCommands['checkRepoHooks']
  inspectRepoSetupScriptImports: RuntimeRepositoryHooksCommands['inspectRepoSetupScriptImports']
  readRepoIssueCommand: RuntimeRepositoryIssueCommand['read']
  writeRepoIssueCommand: RuntimeRepositoryIssueCommand['write']
} & Pick<RuntimeHostedReviewCommands, HostedReviewCommandName> &
  Pick<RuntimeGitHubRepositoryQueryCommands, GitHubRepositoryQueryCommandName>

type RuntimeRepositoryCommandOwners = {
  projectHostSetups: RuntimeProjectHostSetupController
  projectGroups: RuntimeProjectGroupController
  nestedRepoImport: RuntimeNestedRepoImport
  serverEnvironment: RuntimeServerEnvironmentCommands
  repositorySparsePresets: RuntimeRepositorySparsePresets
  repositoryRegistrations: RuntimeRepositoryRegistrationController
  repositoryClones: RuntimeRepositoryCloneController
  repositorySettings: RuntimeRepositorySettingsController
  repositoryRefQueries: RuntimeRepositoryRefQueries
  hostedReviews: RuntimeHostedReviewCommands
  gitHubRepositoryQueries: RuntimeGitHubRepositoryQueryCommands
  repositoryHooks: RuntimeRepositoryHooksCommands
  repositoryIssueCommand: RuntimeRepositoryIssueCommand
}

export function installRuntimeRepositoryCommandSurface(
  target: RuntimeRepositoryCommandSurface,
  owners: RuntimeRepositoryCommandOwners
): void {
  const host = owners.projectHostSetups
  const groups = owners.projectGroups
  const nested = owners.nestedRepoImport
  const server = owners.serverEnvironment
  const sparse = owners.repositorySparsePresets
  const registrations = owners.repositoryRegistrations
  const clones = owners.repositoryClones
  const settings = owners.repositorySettings
  const refs = owners.repositoryRefQueries
  const reviews = owners.hostedReviews
  const queries = owners.gitHubRepositoryQueries
  const hooks = owners.repositoryHooks
  const issueCommand = owners.repositoryIssueCommand
  Object.assign(target, {
    listProjects: host.listProjects.bind(host),
    updateProject: host.updateProject.bind(host),
    listProjectHostSetups: host.listSetups.bind(host),
    createProjectHostSetup: host.createSetup.bind(host),
    setupProjectExistingFolder: host.setupExistingFolder.bind(host),
    setupProjectClone: host.setupClone.bind(host),
    updateProjectHostSetup: host.updateSetup.bind(host),
    deleteProjectHostSetup: host.deleteSetup.bind(host),
    listProjectGroups: groups.listGroups.bind(groups),
    listFolderWorkspaces: groups.listFolderWorkspaces.bind(groups),
    createProjectGroup: groups.createGroup.bind(groups),
    updateProjectGroup: groups.updateGroup.bind(groups),
    deleteProjectGroup: groups.deleteGroup.bind(groups),
    moveProjectToGroup: groups.moveProject.bind(groups),
    createFolderWorkspace: groups.createFolderWorkspace.bind(groups),
    getFolderWorkspacePathStatus: groups.getFolderPathStatus.bind(groups),
    updateFolderWorkspace: groups.updateFolderWorkspace.bind(groups),
    deleteFolderWorkspace: groups.deleteFolderWorkspace.bind(groups),
    scanNestedRepos: nested.scan.bind(nested),
    importNestedRepos: nested.import.bind(nested),
    browseServerDir: server.browseDirectory.bind(server),
    isGitAvailable: server.isGitAvailable.bind(server),
    listSparsePresets: sparse.list.bind(sparse),
    saveSparsePreset: sparse.save.bind(sparse),
    addRepo: registrations.add.bind(registrations),
    createRepo: registrations.create.bind(registrations),
    cloneRepo: clones.clone.bind(clones),
    showRepo: settings.show.bind(settings),
    setRepoBaseRef: settings.setBaseRef.bind(settings),
    updateRepo: settings.update.bind(settings),
    removeProject: settings.remove.bind(settings),
    reorderRepos: settings.reorder.bind(settings),
    getRepoBaseRefDefault: refs.getDefault.bind(refs),
    getRepoSlug: reviews.getRepoSlug.bind(reviews),
    getRepoUpstream: reviews.getRepoUpstream.bind(reviews),
    getRepoPRForBranch: reviews.getRepoPRForBranch.bind(reviews),
    getHostedReviewForBranch: reviews.getHostedReviewForBranch.bind(reviews),
    getHostedReviewCreationEligibility: reviews.getHostedReviewCreationEligibility.bind(reviews),
    createHostedReview: reviews.createHostedReview.bind(reviews),
    createStackedHostedReview: reviews.createStackedHostedReview.bind(reviews),
    listRepoWorkItems: queries.listRepoWorkItems.bind(queries),
    listRepoIssues: queries.listRepoIssues.bind(queries),
    getRepoWorkItem: queries.getRepoWorkItem.bind(queries),
    getRepoWorkItemByOwnerRepo: queries.getRepoWorkItemByOwnerRepo.bind(queries),
    getRepoWorkItemDetails: queries.getRepoWorkItemDetails.bind(queries),
    countRepoWorkItems: queries.countRepoWorkItems.bind(queries),
    listRepoLabels: queries.listRepoLabels.bind(queries),
    listRepoAssignableUsers: queries.listRepoAssignableUsers.bind(queries),
    getGitHubRateLimit: queries.getGitHubRateLimit.bind(queries),
    getRepoHooks: hooks.getRepoHooks.bind(hooks),
    checkRepoHooks: hooks.checkRepoHooks.bind(hooks),
    inspectRepoSetupScriptImports: hooks.inspectRepoSetupScriptImports.bind(hooks),
    readRepoIssueCommand: issueCommand.read.bind(issueCommand),
    writeRepoIssueCommand: issueCommand.write.bind(issueCommand)
  })
}

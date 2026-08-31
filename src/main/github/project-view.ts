// Re-export the public API so existing `./project-view` call sites keep working; the split is internal-only.
export { isValidOwnerSlug, isValidRepoSlug } from './project-view/internals'
export { classifyProjectError } from './project-view/project-error-classification'
export { updateIssueBySlug } from './project-view/mutations'
export {
  updateProjectItemFieldValue,
  clearProjectItemFieldValue
} from './project-view/project-field-mutations'
export { updatePullRequestBySlug } from './project-view/pull-request-mutation'
export {
  addIssueCommentBySlug,
  updateIssueCommentBySlug,
  deleteIssueCommentBySlug
} from './project-view/issue-comment-mutations'
export {
  listLabelsBySlug,
  listAssignableUsersBySlug,
  listIssueTypesBySlug
} from './project-view/repository-field-options'
export { updateIssueTypeBySlug } from './project-view/issue-type-mutation'
export { getWorkItemDetailsBySlug } from './project-view/work-item-details'
export {
  PROJECT_VIEW_OWNER_CACHE_MAX_ENTRIES,
  _resetProjectViewCachesForTests,
  _getProjectViewCacheSizesForTests,
  _rememberProjectViewOwnerTypeForTests,
  _getProjectViewOwnerTypeForTests,
  _markProjectViewParentFieldRetriedForTests,
  _hasProjectViewParentFieldRetriedForTests,
  _markProjectViewParentFieldWarningLoggedForTests,
  _hasProjectViewParentFieldWarningLoggedForTests
} from './project-view/project-view-cache'
export {
  normalizeField,
  normalizeFieldValue
} from './project-view/project-view-field-normalization'
export { normalizeItem } from './project-view/project-view-item-normalization'
export { getProjectViewTable } from './project-view/project-view-table'
export { listAccessibleProjects } from './project-view/project-view-discovery'
export { parseProjectPaste, resolveProjectRef } from './project-view/project-view-reference'
export { listProjectViews } from './project-view/project-view-listing'

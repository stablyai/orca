import { registerAppHandler } from '../app-registry/app-handler-registry'

import { runAsDefaultWslCliUserAct } from '../../git/command-runner/hosted-cli/default-wsl-cli-fallback'
import type {
  AddIssueCommentBySlugArgs,
  ClearProjectItemFieldArgs,
  DeleteIssueCommentBySlugArgs,
  GetProjectViewTableArgs,
  ListAccessibleProjectsArgs,
  ListAssignableUsersBySlugArgs,
  ListIssueTypesBySlugArgs,
  ListLabelsBySlugArgs,
  ListProjectViewsArgs,
  ProjectWorkItemDetailsBySlugArgs,
  ResolveProjectRefArgs,
  UpdateIssueBySlugArgs,
  UpdateIssueCommentBySlugArgs,
  UpdateIssueTypeBySlugArgs,
  UpdateProjectItemFieldArgs,
  UpdatePullRequestBySlugArgs,
  WakeWslDistroArg
} from '../../../shared/github/projects/project-request-types'
import {
  addIssueCommentBySlug,
  deleteIssueCommentBySlug,
  updateIssueCommentBySlug
} from '../../github/project-view/issue-comment-mutations'
import {
  clearProjectItemFieldValue,
  updateProjectItemFieldValue
} from '../../github/project-view/project-field-mutations'
import { getProjectViewTable } from '../../github/project-view/project-view-table'
import { getWorkItemDetailsBySlug } from '../../github/project-view/work-item-details'
import { listAccessibleProjects } from '../../github/project-view/project-view-discovery'
import {
  listAssignableUsersBySlug,
  listIssueTypesBySlug,
  listLabelsBySlug
} from '../../github/project-view/repository-field-options'
import { listProjectViews } from '../../github/project-view/project-view-listing'
import { resolveProjectRef } from '../../github/project-view/project-view-reference'
import { updateIssueBySlug } from '../../github/project-view/mutations'
import { updateIssueTypeBySlug } from '../../github/project-view/issue-type-mutation'
import { updatePullRequestBySlug } from '../../github/project-view/pull-request-mutation'

// Only a click (the renderer sets wakeWslDistro) may start the stopped distro gh lives in (E9); the
// same reads also run from mount effects on a restored page, which must stay gated.
function wakeOnClick<T>(args: WakeWslDistroArg | undefined, act: () => Promise<T>): Promise<T> {
  return args?.wakeWslDistro === true ? runAsDefaultWslCliUserAct(act) : act()
}

export function registerGitHubProjectViewHandlers(): void {
  registerAppHandler('gh:listAccessibleProjects', (_event, args?: ListAccessibleProjectsArgs) =>
    wakeOnClick(args, () => listAccessibleProjects(args))
  )
  registerAppHandler('gh:resolveProjectRef', (_event, args: ResolveProjectRefArgs) =>
    wakeOnClick(args, () => resolveProjectRef(args))
  )
  registerAppHandler('gh:listProjectViews', (_event, args: ListProjectViewsArgs) =>
    wakeOnClick(args, () => listProjectViews(args))
  )
  registerAppHandler('gh:getProjectViewTable', (_event, args: GetProjectViewTableArgs) =>
    getProjectViewTable(args)
  )
  registerAppHandler(
    'gh:projectWorkItemDetailsBySlug',
    (_event, args: ProjectWorkItemDetailsBySlugArgs) =>
      wakeOnClick(args, () => getWorkItemDetailsBySlug(args))
  )
  registerAppHandler('gh:updateProjectItemField', (_event, args: UpdateProjectItemFieldArgs) =>
    wakeOnClick(args, () => updateProjectItemFieldValue(args))
  )
  registerAppHandler('gh:clearProjectItemField', (_event, args: ClearProjectItemFieldArgs) =>
    wakeOnClick(args, () => clearProjectItemFieldValue(args))
  )
  registerAppHandler('gh:updateIssueBySlug', (_event, args: UpdateIssueBySlugArgs) =>
    wakeOnClick(args, () => updateIssueBySlug(args))
  )
  registerAppHandler('gh:updatePullRequestBySlug', (_event, args: UpdatePullRequestBySlugArgs) =>
    wakeOnClick(args, () => updatePullRequestBySlug(args))
  )
  registerAppHandler('gh:addIssueCommentBySlug', (_event, args: AddIssueCommentBySlugArgs) =>
    wakeOnClick(args, () => addIssueCommentBySlug(args))
  )
  registerAppHandler('gh:updateIssueCommentBySlug', (_event, args: UpdateIssueCommentBySlugArgs) =>
    wakeOnClick(args, () => updateIssueCommentBySlug(args))
  )
  registerAppHandler('gh:deleteIssueCommentBySlug', (_event, args: DeleteIssueCommentBySlugArgs) =>
    wakeOnClick(args, () => deleteIssueCommentBySlug(args))
  )
  registerAppHandler('gh:listLabelsBySlug', (_event, args: ListLabelsBySlugArgs) =>
    listLabelsBySlug(args)
  )
  registerAppHandler(
    'gh:listAssignableUsersBySlug',
    (_event, args: ListAssignableUsersBySlugArgs) => listAssignableUsersBySlug(args)
  )
  registerAppHandler('gh:listIssueTypesBySlug', (_event, args: ListIssueTypesBySlugArgs) =>
    listIssueTypesBySlug(args)
  )
  registerAppHandler('gh:updateIssueTypeBySlug', (_event, args: UpdateIssueTypeBySlugArgs) =>
    wakeOnClick(args, () => updateIssueTypeBySlug(args))
  )
}

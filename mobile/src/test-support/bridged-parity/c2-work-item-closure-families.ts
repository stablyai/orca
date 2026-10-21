import type { PageClosurePins } from './page-closure'

/**
 * The C2 closure families reached by opening one work item, and what each golden did at the bridge.
 *
 * Split from `c2-page-closure.ts` at the domain's own seam rather than at a line count: these are
 * the families a task item's own screen drives — its detail, metadata, checks, comments, review
 * threads and the writes that change its state — and the file next door is what chooses which item
 * to open. Both are data the composed table spreads; neither is meant to be read alone.
 *
 * Verdicts are C2's classification rule, which decides only the families this domain adds: a
 * `matrix-*` golden, or one whose scenario scripts `{ ok: true }` with no `result`, is
 * `result-absent-settlement`; the five families the design measured as wholly divergent are
 * `params-undefined`; everything else replays byte for byte.
 */
export const C2_WORK_ITEM_CLOSURE_FAMILIES: PageClosurePins = {
  'linear-detail-barrier': {
    b3: 'identical',
    'lifecycle-b3': 'identical',
    'matrix-linear-detail-barrier-linear.getissue-1': 'result-absent-settlement',
    'matrix-linear-detail-barrier-linear.issuecomments-1': 'result-absent-settlement',
    'schedules-b3': 'identical'
  },
  'tasks.item-checks-files': {
    'matrix-tasks.item-checks-files-github.addprreviewcomment-1': 'params-undefined',
    'matrix-tasks.item-checks-files-github.prfilecontents-1': 'params-undefined',
    'matrix-tasks.item-checks-files-github.rerunprchecks-1': 'params-undefined',
    'matrix-tasks.item-checks-files-github.resolvereviewthread-1': 'params-undefined',
    'matrix-tasks.item-checks-files-github.setprfileviewed-1': 'params-undefined',
    'tk-item-checks-files': 'params-undefined'
  },
  'tasks.item-comment-github': {
    'matrix-tasks.item-comment-github-github.addissuecomment-1': 'result-absent-settlement',
    'tk-item-comment-github': 'identical'
  },
  'tasks.item-comment-gitlab': {
    'matrix-tasks.item-comment-gitlab-gitlab.addissuecomment-1': 'result-absent-settlement',
    'tk-item-comment-gitlab': 'identical'
  },
  'tasks.item-comment-gitlab-mr': {
    'matrix-tasks.item-comment-gitlab-mr-gitlab.addmrcomment-1': 'result-absent-settlement',
    'tk-item-comment-gitlab-mr': 'identical'
  },
  'tasks.item-detail-github': {
    'matrix-tasks.item-detail-github-github.workitemdetails-1': 'result-absent-settlement',
    'tk-item-detail-github': 'identical',
    'tk-item-detail-github-reactions': 'identical'
  },
  'tasks.item-detail-gitlab': {
    'matrix-tasks.item-detail-gitlab-gitlab.workitemdetails-1': 'result-absent-settlement',
    'tk-item-detail-gitlab': 'identical',
    'tk-item-detail-gitlab-reactions': 'identical'
  },
  'tasks.item-detail-linear': {
    'matrix-tasks.item-detail-linear-linear.getissue-1': 'result-absent-settlement',
    'matrix-tasks.item-detail-linear-linear.issuecomments-1': 'result-absent-settlement',
    'tk-item-detail-linear': 'identical'
  },
  'tasks.item-detail-metadata': {
    'matrix-tasks.item-detail-metadata-github.listassignableusers-1': 'result-absent-settlement',
    'matrix-tasks.item-detail-metadata-github.listlabels-1': 'result-absent-settlement',
    'tk-item-detail-metadata': 'identical'
  },
  'tasks.item-merge-gitlab': {
    'matrix-tasks.item-merge-gitlab-gitlab.mergemr-1': 'result-absent-settlement',
    'tk-item-merge-gitlab': 'identical'
  },
  'tasks.item-metadata-github': {
    'matrix-tasks.item-metadata-github-github.updatepr-1': 'result-absent-settlement',
    'tk-item-metadata-github': 'identical'
  },
  'tasks.item-metadata-gitlab': {
    'matrix-tasks.item-metadata-gitlab-gitlab.updateissue-1': 'result-absent-settlement',
    'tk-item-metadata-gitlab': 'identical'
  },
  'tasks.item-metadata-gitlab-mr': {
    'matrix-tasks.item-metadata-gitlab-mr-gitlab.updatemr-1': 'params-undefined',
    'tk-item-metadata-gitlab-mr': 'params-undefined'
  },
  'tasks.item-reply-merge': {
    'matrix-tasks.item-reply-merge-github.addissuecomment-1': 'result-absent-settlement',
    'matrix-tasks.item-reply-merge-github.addprreviewcommentreply-1': 'result-absent-settlement',
    'matrix-tasks.item-reply-merge-github.mergepr-1': 'result-absent-settlement',
    'matrix-tasks.item-reply-merge-linear.updateissue-1': 'result-absent-settlement',
    'tk-item-reply-merge': 'identical'
  },
  'tasks.item-review-github': {
    'matrix-tasks.item-review-github-github.prchecks-1': 'result-absent-settlement',
    'matrix-tasks.item-review-github-github.requestprreviewers-1': 'result-absent-settlement',
    'tk-item-review-github': 'identical'
  },
  'tasks.item-status-gitlab': {
    'matrix-tasks.item-status-gitlab-github.updateissue-1': 'result-absent-settlement',
    'matrix-tasks.item-status-gitlab-gitlab.updateissue-1': 'result-absent-settlement',
    'tk-item-status-gitlab': 'identical'
  },
  'tasks.item-status-gitlab-mr': {
    'matrix-tasks.item-status-gitlab-mr-gitlab.updatemrstate-1': 'result-absent-settlement',
    'tk-item-status-gitlab-mr': 'identical'
  },
  'tasks.linear-item': {
    'matrix-tasks.linear-item-linear.addissuecomment-1': 'result-absent-settlement',
    'matrix-tasks.linear-item-linear.createissue-1': 'result-absent-settlement',
    'matrix-tasks.linear-item-linear.getissue-1': 'result-absent-settlement',
    'tk-linear-item': 'identical'
  },
  'tasks.project-row-comments-issue': {
    'matrix-tasks.project-row-comments-issue-github.project.addissuecommentbyslug-1':
      'result-absent-settlement',
    'matrix-tasks.project-row-comments-issue-github.project.updateissuebyslug-1':
      'result-absent-settlement',
    'matrix-tasks.project-row-comments-issue-github.project.updateissuecommentbyslug-1':
      'result-absent-settlement',
    'tk-project-row-comments-issue': 'identical'
  },
  'tasks.project-row-comments-pr': {
    'matrix-tasks.project-row-comments-pr-github.project.updatepullrequestbyslug-1':
      'result-absent-settlement',
    'tk-project-row-comments-pr': 'identical'
  },
  'tasks.project-row-detail': {
    'matrix-tasks.project-row-detail-github.project.workitemdetailsbyslug-1':
      'result-absent-settlement',
    'tk-project-row-detail': 'identical'
  },
  'tasks.project-row-fields': {
    'matrix-tasks.project-row-fields-github.project.clearitemfield-1': 'result-absent-settlement',
    'matrix-tasks.project-row-fields-github.project.updateissuetypebyslug-1':
      'result-absent-settlement',
    'matrix-tasks.project-row-fields-github.project.updateitemfield-1': 'result-absent-settlement',
    'tk-project-row-fields': 'identical'
  },
  'tasks.project-row-files-merge': {
    'matrix-tasks.project-row-files-merge-github.addprreviewcomment-1': 'params-undefined',
    'matrix-tasks.project-row-files-merge-github.mergepr-1': 'params-undefined',
    'matrix-tasks.project-row-files-merge-github.prfilecontents-1': 'params-undefined',
    'matrix-tasks.project-row-files-merge-github.updateissue-1': 'params-undefined',
    'matrix-tasks.project-row-files-merge-github.updateprstate-1': 'params-undefined',
    'tk-project-row-files-merge': 'params-undefined'
  },
  'tasks.project-row-metadata-load': {
    'matrix-tasks.project-row-metadata-load-github.project.listassignableusersbyslug-1':
      'result-absent-settlement',
    'matrix-tasks.project-row-metadata-load-github.project.listissuetypesbyslug-1':
      'result-absent-settlement',
    'matrix-tasks.project-row-metadata-load-github.project.listlabelsbyslug-1':
      'result-absent-settlement',
    'tk-project-row-metadata-load': 'identical'
  },
  'tasks.project-row-review-checks': {
    'matrix-tasks.project-row-review-checks-github.prchecks-1': 'result-absent-settlement',
    'matrix-tasks.project-row-review-checks-github.requestprreviewers-1':
      'result-absent-settlement',
    'matrix-tasks.project-row-review-checks-github.rerunprchecks-1': 'result-absent-settlement',
    'matrix-tasks.project-row-review-checks-github.setprfileviewed-1': 'result-absent-settlement',
    'tk-project-row-review-checks': 'identical'
  },
  'tasks.project-row-threads': {
    'matrix-tasks.project-row-threads-github.addissuecomment-1': 'result-absent-settlement',
    'matrix-tasks.project-row-threads-github.addprreviewcommentreply-1': 'result-absent-settlement',
    'matrix-tasks.project-row-threads-github.project.deleteissuecommentbyslug-1':
      'result-absent-settlement',
    'matrix-tasks.project-row-threads-github.resolvereviewthread-1': 'result-absent-settlement',
    'tk-project-row-threads': 'identical'
  }
}

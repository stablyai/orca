import type { PageClosurePins } from './page-closure'

// Classify only C2’s added work-item families; inherited C1 verdicts are pinned separately, not re-derived.
export const C2_WORK_ITEM_CLOSURE_FAMILIES: PageClosurePins = {
  'linear-detail-barrier': {
    b3: 'identical',
    'lifecycle-b3': 'identical',
    'matrix-linear-detail-barrier-linear.getissue-1': 'result-absent-settlement',
    'matrix-linear-detail-barrier-linear.issuecomments-1': 'result-absent-settlement',
    'schedules-b3': 'identical'
  },
  'tasks.item-checks-files': {
    'matrix-tasks.item-checks-files-github.addprreviewcomment-1': { verdict: 'bridge-contract' },
    'matrix-tasks.item-checks-files-github.prfilecontents-1': { verdict: 'bridge-contract' },
    'matrix-tasks.item-checks-files-github.rerunprchecks-1': { verdict: 'bridge-contract' },
    'matrix-tasks.item-checks-files-github.resolvereviewthread-1': { verdict: 'bridge-contract' },
    'matrix-tasks.item-checks-files-github.setprfileviewed-1': { verdict: 'bridge-contract' },
    'tk-item-checks-files': { verdict: 'bridge-contract' }
  },
  'tasks.item-comment-github': {
    'matrix-tasks.item-comment-github-github.addissuecomment-1': { verdict: 'bridge-contract' },
    'tk-item-comment-github': { verdict: 'bridge-contract' }
  },
  'tasks.item-comment-gitlab': {
    'matrix-tasks.item-comment-gitlab-gitlab.addissuecomment-1': { verdict: 'bridge-contract' },
    'tk-item-comment-gitlab': { verdict: 'bridge-contract' }
  },
  'tasks.item-comment-gitlab-mr': {
    'matrix-tasks.item-comment-gitlab-mr-gitlab.addmrcomment-1': { verdict: 'bridge-contract' },
    'tk-item-comment-gitlab-mr': { verdict: 'bridge-contract' }
  },
  'tasks.item-detail-github': {
    'matrix-tasks.item-detail-github-github.workitemdetails-1': { verdict: 'bridge-contract' },
    'tk-item-detail-github': { verdict: 'bridge-contract' },
    'tk-item-detail-github-reactions': { verdict: 'bridge-contract' }
  },
  'tasks.item-detail-gitlab': {
    'matrix-tasks.item-detail-gitlab-gitlab.workitemdetails-1': { verdict: 'bridge-contract' },
    'tk-item-detail-gitlab': { verdict: 'bridge-contract' },
    'tk-item-detail-gitlab-reactions': { verdict: 'bridge-contract' }
  },
  'tasks.item-detail-linear': {
    'matrix-tasks.item-detail-linear-linear.getissue-1': { verdict: 'bridge-contract' },
    'matrix-tasks.item-detail-linear-linear.issuecomments-1': { verdict: 'bridge-contract' },
    'tk-item-detail-linear': { verdict: 'bridge-contract' }
  },
  'tasks.item-detail-metadata': {
    'tk-item-detail-metadata': { verdict: 'bridge-contract' }
  },
  'tasks.item-merge-gitlab': {
    'matrix-tasks.item-merge-gitlab-gitlab.mergemr-1': { verdict: 'bridge-contract' },
    'tk-item-merge-gitlab': { verdict: 'bridge-contract' }
  },
  'tasks.item-metadata-github': {
    'matrix-tasks.item-metadata-github-github.updatepr-1': { verdict: 'bridge-contract' },
    'tk-item-metadata-github': { verdict: 'bridge-contract' }
  },
  'tasks.item-metadata-gitlab': {
    'matrix-tasks.item-metadata-gitlab-gitlab.updateissue-1': { verdict: 'bridge-contract' },
    'tk-item-metadata-gitlab': { verdict: 'bridge-contract' }
  },
  'tasks.item-metadata-gitlab-mr': {
    'matrix-tasks.item-metadata-gitlab-mr-gitlab.updatemr-1': { verdict: 'bridge-contract' },
    'tk-item-metadata-gitlab-mr': { verdict: 'bridge-contract' }
  },
  'tasks.item-reply-merge': {
    'matrix-tasks.item-reply-merge-github.addissuecomment-1': { verdict: 'bridge-contract' },
    'matrix-tasks.item-reply-merge-github.addprreviewcommentreply-1': {
      verdict: 'bridge-contract'
    },
    'matrix-tasks.item-reply-merge-github.mergepr-1': { verdict: 'bridge-contract' },
    'matrix-tasks.item-reply-merge-linear.updateissue-1': { verdict: 'bridge-contract' },
    'tk-item-reply-merge': { verdict: 'bridge-contract' }
  },
  'tasks.item-review-github': {
    'matrix-tasks.item-review-github-github.prchecks-1': { verdict: 'bridge-contract' },
    'matrix-tasks.item-review-github-github.requestprreviewers-1': { verdict: 'bridge-contract' },
    'tk-item-review-github': { verdict: 'bridge-contract' }
  },
  'tasks.item-status-gitlab': {
    'matrix-tasks.item-status-gitlab-github.updateissue-1': { verdict: 'bridge-contract' },
    'matrix-tasks.item-status-gitlab-gitlab.updateissue-1': { verdict: 'bridge-contract' },
    'tk-item-status-gitlab': { verdict: 'bridge-contract' }
  },
  'tasks.item-status-gitlab-mr': {
    'matrix-tasks.item-status-gitlab-mr-gitlab.updatemrstate-1': { verdict: 'bridge-contract' },
    'tk-item-status-gitlab-mr': { verdict: 'bridge-contract' }
  },
  'tasks.linear-item': {
    'matrix-tasks.linear-item-linear.addissuecomment-1': { verdict: 'bridge-contract' },
    'matrix-tasks.linear-item-linear.createissue-1': { verdict: 'bridge-contract' },
    'matrix-tasks.linear-item-linear.getissue-1': { verdict: 'bridge-contract' },
    'tk-linear-item': { verdict: 'bridge-contract' }
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
    'matrix-tasks.project-row-detail-github.project.workitemdetailsbyslug-1': {
      verdict: 'bridge-contract'
    },
    'tk-project-row-detail': { verdict: 'bridge-contract' }
  },
  'tasks.project-row-fields': {
    'matrix-tasks.project-row-fields-github.project.clearitemfield-1': 'result-absent-settlement',
    'matrix-tasks.project-row-fields-github.project.updateissuetypebyslug-1':
      'result-absent-settlement',
    'matrix-tasks.project-row-fields-github.project.updateitemfield-1': 'result-absent-settlement',
    'tk-project-row-fields': 'identical'
  },
  'tasks.project-row-files-merge': {
    'matrix-tasks.project-row-files-merge-github.addprreviewcomment-1': {
      verdict: 'bridge-contract'
    },
    'matrix-tasks.project-row-files-merge-github.mergepr-1': { verdict: 'bridge-contract' },
    'matrix-tasks.project-row-files-merge-github.prfilecontents-1': { verdict: 'bridge-contract' },
    'matrix-tasks.project-row-files-merge-github.updateissue-1': { verdict: 'bridge-contract' },
    'matrix-tasks.project-row-files-merge-github.updateprstate-1': { verdict: 'bridge-contract' },
    'tk-project-row-files-merge': { verdict: 'bridge-contract' }
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

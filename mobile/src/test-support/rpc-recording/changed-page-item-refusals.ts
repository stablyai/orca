import { BRIDGE_REPLY_REFUSED, Retained, type PageRefusal } from './changed-page-refusals'

// The reviewed native detail the Linear screen loads when the absent comments read as none.
const LINEAR_DETAIL = {
  assignee: { $rpc: 'undefined' },
  children: [],
  comments: [],
  description: 'a description',
  labels: [],
  project: { $rpc: 'undefined' },
  provider: 'linear'
}

// The task item screens copy a failed action's error into `error` state and its error effect, which later
// checkpoints still record.
export const ITEM_REFUSALS: Readonly<Record<string, PageRefusal>> = {
  'matrix-tasks.item-checks-files-github.addprreviewcomment-1': {
    request: 'github.addPRReviewComment#1',
    checkpoints: {
      'tk-item-checks-files.result-absent:file-comment-settled': [
        'state.error',
        'effects[52].value'
      ]
    }
  },
  'matrix-tasks.item-checks-files-github.prfilecontents-1': {
    request: 'github.prFileContents#1',
    checkpoints: {
      'tk-item-checks-files.result-absent:expand-settled': ['state.error', 'effects[48].value'],
      'tk-item-checks-files.result-absent:file-comment-settled': ['effects[48].value']
    }
  },
  'matrix-tasks.item-checks-files-github.rerunprchecks-1': {
    request: 'github.rerunPRChecks#1',
    checkpoints: {
      'tk-item-checks-files.result-absent:rerun-settled': ['state.error', 'effects[34].value'],
      'tk-item-checks-files.result-absent:viewed-settled': ['effects[34].value'],
      'tk-item-checks-files.result-absent:thread-settled': ['effects[34].value'],
      'tk-item-checks-files.result-absent:expand-settled': ['effects[34].value'],
      'tk-item-checks-files.result-absent:file-comment-settled': ['effects[34].value']
    }
  },
  'matrix-tasks.item-checks-files-github.resolvereviewthread-1': {
    request: 'github.resolveReviewThread#1',
    checkpoints: {
      'tk-item-checks-files.result-absent:thread-settled': ['state.error', 'effects[42].value'],
      'tk-item-checks-files.result-absent:expand-settled': ['effects[42].value'],
      'tk-item-checks-files.result-absent:file-comment-settled': ['effects[42].value']
    }
  },
  'matrix-tasks.item-checks-files-github.setprfileviewed-1': {
    request: 'github.setPRFileViewed#1',
    checkpoints: {
      'tk-item-checks-files.result-absent:viewed-settled': ['state.error', 'effects[38].value'],
      'tk-item-checks-files.result-absent:thread-settled': ['effects[38].value'],
      'tk-item-checks-files.result-absent:expand-settled': ['effects[38].value'],
      'tk-item-checks-files.result-absent:file-comment-settled': ['effects[38].value']
    }
  },
  'matrix-tasks.item-comment-github-github.addissuecomment-1': {
    request: 'github.addIssueComment#1',
    checkpoints: {
      'tk-item-comment-github.result-absent:comment-settled': ['state.error', 'effects[35].value']
    }
  },
  'matrix-tasks.item-comment-gitlab-gitlab.addissuecomment-1': {
    request: 'gitlab.addIssueComment#1',
    checkpoints: {
      'tk-item-comment-gitlab.result-absent:comment-settled': ['state.error', 'effects[35].value']
    }
  },
  'matrix-tasks.item-comment-gitlab-mr-gitlab.addmrcomment-1': {
    request: 'gitlab.addMRComment#1',
    checkpoints: {
      'tk-item-comment-gitlab-mr.result-absent:comment-settled': [
        'state.error',
        'effects[35].value'
      ]
    }
  },
  'matrix-tasks.item-detail-github-github.workitemdetails-1': {
    request: 'github.workItemDetails#1',
    checkpoints: {
      'tk-item-detail-github.result-absent:mounted': ['state.error', 'effects[7].value']
    }
  },
  'matrix-tasks.item-detail-gitlab-gitlab.workitemdetails-1': {
    request: 'gitlab.workItemDetails#1',
    checkpoints: {
      'tk-item-detail-gitlab.result-absent:mounted': ['state.error', 'effects[7].value']
    }
  },
  'matrix-tasks.item-detail-linear-linear.getissue-1': {
    request: 'linear.getIssue#1',
    checkpoints: {
      'tk-item-detail-linear.result-absent:mounted': ['state.error', 'effects[7].value']
    }
  },
  // Natively the absent comments read as none and the detail loads; the page's refusal fails the load
  // instead (the catch shows it, the finally still resets loading).
  'matrix-tasks.item-detail-linear-linear.issuecomments-1': {
    request: 'linear.issueComments#1',
    checkpoints: {
      'tk-item-detail-linear.result-absent:mounted': {
        state: { error: ['', BRIDGE_REPLY_REFUSED], payload: [LINEAR_DETAIL, { $rpc: 'null' }] },
        effects: [
          [
            ['detailLoading', false],
            ['detailPayload', LINEAR_DETAIL]
          ],
          [
            ['detailError', BRIDGE_REPLY_REFUSED],
            ['detailLoading', false]
          ]
        ]
      }
    }
  },
  'matrix-tasks.item-merge-gitlab-gitlab.mergemr-1': {
    request: 'gitlab.mergeMR#1',
    checkpoints: {
      'tk-item-merge-gitlab.result-absent:merge-settled': ['state.error', 'effects[34].value']
    }
  },
  'matrix-tasks.item-metadata-github-github.updatepr-1': {
    request: 'github.updatePR#1',
    checkpoints: {
      'tk-item-metadata-github.result-absent:update-pr-settled': [
        'state.error',
        'effects[33].value'
      ]
    }
  },
  'matrix-tasks.item-metadata-gitlab-gitlab.updateissue-1': {
    request: 'gitlab.updateIssue#1',
    checkpoints: {
      'tk-item-metadata-gitlab.result-absent:update-gitlab-settled': [
        'state.error',
        'effects[33].value'
      ]
    }
  },
  'matrix-tasks.item-metadata-gitlab-mr-gitlab.updatemr-1': {
    request: 'gitlab.updateMR#1',
    checkpoints: {
      'tk-item-metadata-gitlab-mr.result-absent:update-gitlab-settled': [
        'state.error',
        'effects[33].value'
      ]
    }
  },
  'matrix-tasks.item-reply-merge-github.addissuecomment-1': {
    request: 'github.addIssueComment#1',
    checkpoints: {
      'tk-item-reply-merge.result-absent:issue-reply-settled': ['state.error', 'effects[40].value'],
      'tk-item-reply-merge.result-absent:merge-settled': ['effects[40].value'],
      'tk-item-reply-merge.result-absent:linear-status-settled': ['effects[40].value']
    }
  },
  'matrix-tasks.item-reply-merge-github.addprreviewcommentreply-1': {
    request: 'github.addPRReviewCommentReply#1',
    checkpoints: {
      'tk-item-reply-merge.result-absent:review-reply-settled': [
        'state.error',
        'effects[34].value'
      ],
      'tk-item-reply-merge.result-absent:issue-reply-settled': ['effects[34].value'],
      'tk-item-reply-merge.result-absent:merge-settled': ['effects[34].value'],
      'tk-item-reply-merge.result-absent:linear-status-settled': ['effects[34].value']
    }
  },
  'matrix-tasks.item-reply-merge-github.mergepr-1': {
    request: 'github.mergePR#1',
    checkpoints: {
      'tk-item-reply-merge.result-absent:merge-settled': ['state.error', 'effects[46].value'],
      'tk-item-reply-merge.result-absent:linear-status-settled': ['effects[46].value']
    }
  },
  // Natively the absent result reads as a successful status change; the page's refusal shows the error and
  // leaves the shown items as they were.
  'matrix-tasks.item-reply-merge-linear.updateissue-1': {
    request: 'linear.updateIssue#1',
    checkpoints: {
      'tk-item-reply-merge.result-absent:linear-status-settled': {
        state: { error: ['', BRIDGE_REPLY_REFUSED] },
        effects: [
          [
            ['items', new Retained('items')],
            ['mutatingStatus', false]
          ],
          [
            ['error', BRIDGE_REPLY_REFUSED],
            ['mutatingStatus', false]
          ]
        ]
      }
    }
  },
  'matrix-tasks.item-review-github-github.prchecks-1': {
    request: 'github.prChecks#1',
    checkpoints: {
      'tk-item-review-github.result-absent:checks-settled': ['state.error', 'effects[42].value']
    }
  },
  'matrix-tasks.item-review-github-github.requestprreviewers-1': {
    request: 'github.requestPRReviewers#1',
    checkpoints: {
      'tk-item-review-github.result-absent:reviewers-settled': ['state.error', 'effects[35].value'],
      'tk-item-review-github.result-absent:checks-settled': ['effects[35].value']
    }
  },
  'matrix-tasks.item-status-gitlab-github.updateissue-1': {
    request: 'github.updateIssue#1',
    checkpoints: {
      'tk-item-status-gitlab.result-absent:github-metadata-settled': [
        'state.error',
        'effects[38].value'
      ]
    }
  },
  'matrix-tasks.item-status-gitlab-gitlab.updateissue-1': {
    request: 'gitlab.updateIssue#1',
    checkpoints: {
      'tk-item-status-gitlab.result-absent:gitlab-status-settled': [
        'state.error',
        'effects[33].value'
      ],
      'tk-item-status-gitlab.result-absent:github-metadata-settled': ['effects[33].value']
    }
  },
  'matrix-tasks.item-status-gitlab-mr-gitlab.updatemrstate-1': {
    request: 'gitlab.updateMRState#1',
    checkpoints: {
      'tk-item-status-gitlab-mr.result-absent:gitlab-status-settled': [
        'state.error',
        'effects[33].value'
      ]
    }
  },
  'matrix-tasks.item-detail-github-status.get-1': {
    request: 'status.get#1',
    checkpoints: {
      'tk-item-detail-github.result-absent:mounted': ['state.error', 'effects[7].value']
    }
  },
  'matrix-tasks.item-detail-gitlab-gitlab.workitemdetails-2': {
    request: 'gitlab.workItemDetails#2',
    checkpoints: {
      'tk-item-detail-gitlab.result-absent:mounted': ['state.error', 'effects[13].value']
    }
  },
  'matrix-tasks.item-status-gitlab-status.get-1': {
    request: 'status.get#1',
    checkpoints: {
      'tk-item-status-gitlab.result-absent:github-metadata-settled': [
        'state.error',
        'effects[38].value'
      ]
    }
  }
}

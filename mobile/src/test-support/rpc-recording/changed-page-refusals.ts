import type { RecordedValue } from './recording-values'

// The finite page outcomes of the changed producers' injected absent results, by producer and checkpoint.

export const BRIDGE_REPLY_REFUSED = 'the reply could not be read (unrecognised-message)'

/** A native effect value that equals what native state still shows under this key. */
export class Retained {
  constructor(readonly key: string) {}
}

/** Where the page run ends differently from native, each edit naming the native value it replaces. */
export type PageEnding = {
  readonly state: Readonly<Record<string, readonly [native: RecordedValue, page: RecordedValue]>>
  /** Native's last effects the page does not reach, then the page's own at the same ordinals. */
  readonly effects: readonly [
    native: readonly (readonly [name: string, value: RecordedValue | Retained])[],
    page: readonly (readonly [name: string, value: RecordedValue])[]
  ]
}

/**
 * The bound request whose injected absent result the page refuses, and each checkpoint that observes that
 * refusal: the slots where the screen copies the request's error (none where it shows nothing), or the
 * different ending the screen reaches instead.
 */
export type PageRefusal = {
  readonly request: string
  readonly checkpoints: Readonly<Record<string, readonly string[] | PageEnding>>
}

// The read surface copies each read's error into that read's own settlement and state.
function surfaceRead(request: string, key: string, checkpoints: readonly string[]): PageRefusal {
  const slots = [`settlements.${key}.value.error`, `state.${key}.error`]
  return {
    request,
    checkpoints: Object.fromEntries(
      checkpoints.map((checkpoint) => [`pr-read-surface.result-absent:${checkpoint}`, slots])
    )
  }
}

const AFTER_WORK_ITEM = ['work-item', 'checks', 'check-details', 'assignable']
const AFTER_HOSTED_REVIEW = ['hosted-review', 'pr-for-branch', ...AFTER_WORK_ITEM]

export const READ_AND_PROJECT_REFUSALS: Readonly<Record<string, PageRefusal>> = {
  'matrix-github.pr-read-github.listassignableusers-1': surfaceRead(
    'github.listAssignableUsers#1',
    'assignable',
    ['assignable']
  ),
  'matrix-github.pr-read-github.prcheckdetails-1': surfaceRead(
    'github.prCheckDetails#1',
    'check-details',
    ['check-details', 'assignable']
  ),
  'matrix-github.pr-read-github.prchecks-1': surfaceRead('github.prChecks#1', 'checks', [
    'checks',
    'check-details',
    'assignable'
  ]),
  'matrix-github.pr-read-github.prforbranch-1': surfaceRead(
    'github.prForBranch#1',
    'pr-for-branch',
    ['pr-for-branch', ...AFTER_WORK_ITEM]
  ),
  'matrix-github.pr-read-github.reposlug-1': surfaceRead('github.repoSlug#1', 'repo-slug', [
    'repo-slug',
    ...AFTER_HOSTED_REVIEW
  ]),
  'matrix-github.pr-read-github.workitemdetails-1': surfaceRead(
    'github.workItemDetails#1',
    'work-item',
    AFTER_WORK_ITEM
  ),
  'matrix-github.pr-read-hostedreview.forbranch-1': surfaceRead(
    'hostedReview.forBranch#1',
    'hosted-review',
    AFTER_HOSTED_REVIEW
  ),
  'matrix-github.pr-read-status.get-1': surfaceRead('status.get#1', 'assignable', ['assignable']),
  'matrix-tasks.linear-item-linear.addissuecomment-1': {
    request: 'linear.addIssueComment#1',
    checkpoints: {
      'tk-linear-item.result-absent:comment-settled': ['state.error', 'effects[34].value'],
      'tk-linear-item.result-absent:sub-issue-open-settled': ['effects[34].value'],
      'tk-linear-item.result-absent:sub-issue-create-settled': ['effects[34].value']
    }
  },
  'matrix-tasks.linear-item-linear.createissue-1': {
    request: 'linear.createIssue#1',
    checkpoints: {
      'tk-linear-item.result-absent:sub-issue-create-settled': ['state.error', 'effects[44].value']
    }
  },
  'matrix-tasks.linear-item-linear.getissue-1': {
    request: 'linear.getIssue#1',
    checkpoints: {
      'tk-linear-item.result-absent:sub-issue-open-settled': ['state.error', 'effects[40].value'],
      'tk-linear-item.result-absent:sub-issue-create-settled': ['effects[40].value']
    }
  },
  'matrix-tasks.linear-team-context-linear.listteams-1': {
    request: 'linear.listTeams#1',
    checkpoints: {
      'tk-linear-team-context.result-absent:open-composer-settled': [],
      'tk-linear-team-context.result-absent:select-metadata-item-settled': []
    }
  },
  'matrix-tasks.linear-team-context-linear.teamstates-1': {
    request: 'linear.teamStates#1',
    checkpoints: {
      'tk-linear-team-context.result-absent:select-metadata-item-settled': []
    }
  },
  'matrix-tasks.project-row-detail-github.project.workitemdetailsbyslug-1': {
    request: 'github.project.workItemDetailsBySlug#1',
    checkpoints: {
      'tk-project-row-detail.result-absent:mounted': ['state.error', 'effects[14].value']
    }
  },
  'matrix-tasks.project-row-files-merge-github.addprreviewcomment-1': {
    request: 'github.addPRReviewComment#1',
    checkpoints: {
      'tk-project-row-files-merge.result-absent:file-comment-settled': [
        'state.error',
        'effects[36].value'
      ],
      'tk-project-row-files-merge.result-absent:merge-settled': ['effects[36].value'],
      'tk-project-row-files-merge.result-absent:issue-state-settled': ['effects[36].value'],
      'tk-project-row-files-merge.result-absent:pr-state-settled': ['effects[36].value']
    }
  },
  'matrix-tasks.project-row-files-merge-github.mergepr-1': {
    request: 'github.mergePR#1',
    checkpoints: {
      'tk-project-row-files-merge.result-absent:merge-settled': [
        'state.error',
        'effects[41].value'
      ],
      'tk-project-row-files-merge.result-absent:issue-state-settled': [
        'state.error',
        'effects[41].value'
      ],
      'tk-project-row-files-merge.result-absent:pr-state-settled': [
        'state.error',
        'effects[41].value'
      ]
    }
  },
  'matrix-tasks.project-row-files-merge-github.prfilecontents-1': {
    request: 'github.prFileContents#1',
    checkpoints: {
      'tk-project-row-files-merge.result-absent:expand-settled': [
        'state.error',
        'effects[32].value'
      ],
      'tk-project-row-files-merge.result-absent:file-comment-settled': ['effects[32].value'],
      'tk-project-row-files-merge.result-absent:merge-settled': ['effects[32].value'],
      'tk-project-row-files-merge.result-absent:issue-state-settled': ['effects[32].value'],
      'tk-project-row-files-merge.result-absent:pr-state-settled': ['effects[32].value']
    }
  },
  'matrix-tasks.project-row-files-merge-github.updateissue-1': {
    request: 'github.updateIssue#1',
    checkpoints: {
      'tk-project-row-files-merge.result-absent:issue-state-settled': [],
      'tk-project-row-files-merge.result-absent:pr-state-settled': []
    }
  },
  'matrix-tasks.project-row-files-merge-github.updateprstate-1': {
    request: 'github.updatePRState#1',
    checkpoints: {
      'tk-project-row-files-merge.result-absent:pr-state-settled': []
    }
  },
  'matrix-tasks.project-row-files-merge-status.get-1': {
    request: 'status.get#1',
    checkpoints: {
      'tk-project-row-files-merge.result-absent:issue-state-settled': [],
      'tk-project-row-files-merge.result-absent:pr-state-settled': []
    }
  }
}

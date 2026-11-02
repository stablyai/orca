import type { BridgedParityClass } from '../bridged-parity/divergence-classes'
import { isKeyedObject } from '../bridged-parity/divergence-evidence'
import type { RecordedValue } from './recording-values'

// Producers whose input or recorded product contract this PR changed (the re-recorded set). Each earns its own
// direct page outcomes; none is judged by a legacy label or counted in the unchanged tally.
export const CHANGED_PRODUCERS: readonly string[] = [
  'matrix-github.pr-read-github.listassignableusers-1',
  'matrix-github.pr-read-github.prcheckdetails-1',
  'matrix-github.pr-read-github.prchecks-1',
  'matrix-github.pr-read-github.prforbranch-1',
  'matrix-github.pr-read-github.reposlug-1',
  'matrix-github.pr-read-github.workitemdetails-1',
  'matrix-github.pr-read-hostedreview.forbranch-1',
  'matrix-tasks.item-checks-files-github.addprreviewcomment-1',
  'matrix-tasks.item-checks-files-github.prfilecontents-1',
  'matrix-tasks.item-checks-files-github.rerunprchecks-1',
  'matrix-tasks.item-checks-files-github.resolvereviewthread-1',
  'matrix-tasks.item-checks-files-github.setprfileviewed-1',
  'matrix-tasks.item-comment-github-github.addissuecomment-1',
  'matrix-tasks.item-comment-gitlab-gitlab.addissuecomment-1',
  'matrix-tasks.item-comment-gitlab-mr-gitlab.addmrcomment-1',
  'matrix-tasks.item-detail-github-github.workitemdetails-1',
  'matrix-tasks.item-detail-gitlab-gitlab.workitemdetails-1',
  'matrix-tasks.item-detail-linear-linear.getissue-1',
  'matrix-tasks.item-detail-linear-linear.issuecomments-1',
  'matrix-tasks.item-merge-gitlab-gitlab.mergemr-1',
  'matrix-tasks.item-metadata-github-github.updatepr-1',
  'matrix-tasks.item-metadata-gitlab-gitlab.updateissue-1',
  'matrix-tasks.item-metadata-gitlab-mr-gitlab.updatemr-1',
  'matrix-tasks.item-reply-merge-github.addissuecomment-1',
  'matrix-tasks.item-reply-merge-github.addprreviewcommentreply-1',
  'matrix-tasks.item-reply-merge-github.mergepr-1',
  'matrix-tasks.item-reply-merge-linear.updateissue-1',
  'matrix-tasks.item-review-github-github.prchecks-1',
  'matrix-tasks.item-review-github-github.requestprreviewers-1',
  'matrix-tasks.item-status-gitlab-github.updateissue-1',
  'matrix-tasks.item-status-gitlab-gitlab.updateissue-1',
  'matrix-tasks.item-status-gitlab-mr-gitlab.updatemrstate-1',
  'matrix-tasks.linear-item-linear.addissuecomment-1',
  'matrix-tasks.linear-item-linear.createissue-1',
  'matrix-tasks.linear-item-linear.getissue-1',
  'matrix-tasks.linear-team-context-linear.listteams-1',
  'matrix-tasks.linear-team-context-linear.teamstates-1',
  'matrix-tasks.project-row-detail-github.project.workitemdetailsbyslug-1',
  'matrix-tasks.project-row-files-merge-github.addprreviewcomment-1',
  'matrix-tasks.project-row-files-merge-github.mergepr-1',
  'matrix-tasks.project-row-files-merge-github.prfilecontents-1',
  'matrix-tasks.project-row-files-merge-github.updateissue-1',
  'matrix-tasks.project-row-files-merge-github.updateprstate-1',
  'pr-read-surface',
  'tk-item-checks-files',
  'tk-item-comment-github',
  'tk-item-comment-gitlab',
  'tk-item-comment-gitlab-mr',
  'tk-item-detail-github',
  'tk-item-detail-github-reactions',
  'tk-item-detail-gitlab',
  'tk-item-detail-gitlab-reactions',
  'tk-item-detail-linear',
  'tk-item-detail-metadata',
  'tk-item-merge-gitlab',
  'tk-item-metadata-github',
  'tk-item-metadata-gitlab',
  'tk-item-metadata-gitlab-mr',
  'tk-item-reply-merge',
  'tk-item-review-github',
  'tk-item-status-gitlab',
  'tk-item-status-gitlab-mr',
  'tk-linear-item',
  'tk-linear-team-context',
  'tk-project-row-detail',
  'tk-project-row-files-merge',
  'matrix-github.pr-read-status.get-1',
  'matrix-tasks.item-detail-github-status.get-1',
  'matrix-tasks.item-detail-gitlab-gitlab.workitemdetails-2',
  'matrix-tasks.item-status-gitlab-status.get-1',
  'matrix-tasks.project-row-files-merge-status.get-1'
]

type BaselineClass = BridgedParityClass | 'identical'

// Branch-base classes (f2bee638f25) of members moved to direct judging: closure pins, or the admitted baseline
// replay for the eight without one.
export const MOVED_FROM_BASELINE: Readonly<Record<string, BaselineClass>> = {
  'matrix-github.pr-read-github.listassignableusers-1': 'result-absent-settlement',
  'matrix-github.pr-read-github.prcheckdetails-1': 'result-absent-settlement',
  'matrix-github.pr-read-github.prchecks-1': 'result-absent-settlement',
  'matrix-github.pr-read-github.prforbranch-1': 'result-absent-settlement',
  'matrix-github.pr-read-github.reposlug-1': 'result-absent-settlement',
  'matrix-github.pr-read-github.workitemdetails-1': 'result-absent-settlement',
  'matrix-github.pr-read-hostedreview.forbranch-1': 'result-absent-settlement',
  'matrix-tasks.item-checks-files-github.addprreviewcomment-1': 'params-undefined',
  'matrix-tasks.item-checks-files-github.prfilecontents-1': 'params-undefined',
  'matrix-tasks.item-checks-files-github.rerunprchecks-1': 'params-undefined',
  'matrix-tasks.item-checks-files-github.resolvereviewthread-1': 'params-undefined',
  'matrix-tasks.item-checks-files-github.setprfileviewed-1': 'params-undefined',
  'matrix-tasks.item-comment-github-github.addissuecomment-1': 'result-absent-settlement',
  'matrix-tasks.item-comment-gitlab-gitlab.addissuecomment-1': 'result-absent-settlement',
  'matrix-tasks.item-comment-gitlab-mr-gitlab.addmrcomment-1': 'result-absent-settlement',
  'matrix-tasks.item-detail-github-github.workitemdetails-1': 'result-absent-settlement',
  'matrix-tasks.item-detail-gitlab-gitlab.workitemdetails-1': 'result-absent-settlement',
  'matrix-tasks.item-detail-linear-linear.getissue-1': 'result-absent-settlement',
  'matrix-tasks.item-detail-linear-linear.issuecomments-1': 'result-absent-settlement',
  'matrix-tasks.item-merge-gitlab-gitlab.mergemr-1': 'result-absent-settlement',
  'matrix-tasks.item-metadata-github-github.updatepr-1': 'result-absent-settlement',
  'matrix-tasks.item-metadata-gitlab-gitlab.updateissue-1': 'result-absent-settlement',
  'matrix-tasks.item-metadata-gitlab-mr-gitlab.updatemr-1': 'params-undefined',
  'matrix-tasks.item-reply-merge-github.addissuecomment-1': 'result-absent-settlement',
  'matrix-tasks.item-reply-merge-github.addprreviewcommentreply-1': 'result-absent-settlement',
  'matrix-tasks.item-reply-merge-github.mergepr-1': 'result-absent-settlement',
  'matrix-tasks.item-reply-merge-linear.updateissue-1': 'result-absent-settlement',
  'matrix-tasks.item-review-github-github.prchecks-1': 'result-absent-settlement',
  'matrix-tasks.item-review-github-github.requestprreviewers-1': 'result-absent-settlement',
  'matrix-tasks.item-status-gitlab-github.updateissue-1': 'result-absent-settlement',
  'matrix-tasks.item-status-gitlab-gitlab.updateissue-1': 'result-absent-settlement',
  'matrix-tasks.item-status-gitlab-mr-gitlab.updatemrstate-1': 'result-absent-settlement',
  'matrix-tasks.linear-item-linear.addissuecomment-1': 'result-absent-settlement',
  'matrix-tasks.linear-item-linear.createissue-1': 'result-absent-settlement',
  'matrix-tasks.linear-item-linear.getissue-1': 'result-absent-settlement',
  'matrix-tasks.linear-team-context-linear.listteams-1': 'result-absent-settlement',
  'matrix-tasks.linear-team-context-linear.teamstates-1': 'result-absent-settlement',
  'matrix-tasks.project-row-detail-github.project.workitemdetailsbyslug-1':
    'result-absent-settlement',
  'matrix-tasks.project-row-files-merge-github.addprreviewcomment-1': 'params-undefined',
  'matrix-tasks.project-row-files-merge-github.mergepr-1': 'params-undefined',
  'matrix-tasks.project-row-files-merge-github.prfilecontents-1': 'params-undefined',
  'matrix-tasks.project-row-files-merge-github.updateissue-1': 'params-undefined',
  'matrix-tasks.project-row-files-merge-github.updateprstate-1': 'params-undefined',
  'pr-read-surface': 'identical',
  'tk-item-checks-files': 'params-undefined',
  'tk-item-comment-github': 'identical',
  'tk-item-comment-gitlab': 'identical',
  'tk-item-comment-gitlab-mr': 'identical',
  'tk-item-detail-github': 'identical',
  'tk-item-detail-github-reactions': 'identical',
  'tk-item-detail-gitlab': 'identical',
  'tk-item-detail-gitlab-reactions': 'identical',
  'tk-item-detail-linear': 'identical',
  'tk-item-detail-metadata': 'identical',
  'tk-item-merge-gitlab': 'identical',
  'tk-item-metadata-github': 'identical',
  'tk-item-metadata-gitlab': 'identical',
  'tk-item-metadata-gitlab-mr': 'params-undefined',
  'tk-item-reply-merge': 'identical',
  'tk-item-review-github': 'identical',
  'tk-item-status-gitlab': 'identical',
  'tk-item-status-gitlab-mr': 'identical',
  'tk-linear-item': 'identical',
  'tk-linear-team-context': 'identical',
  'tk-project-row-detail': 'identical',
  'tk-project-row-files-merge': 'params-undefined'
}

// Producers the PR removed from the corpus, with their branch-base class.
export const REMOVED_FROM_BASELINE: Readonly<Record<string, BaselineClass>> = {
  'matrix-tasks.item-detail-metadata-github.listassignableusers-1': 'result-absent-settlement',
  'matrix-tasks.item-detail-metadata-github.listlabels-1': 'result-absent-settlement'
}

export function expectedUnchangedTally(
  baseline: Readonly<Record<BaselineClass, number>>
): Record<BaselineClass, number> {
  const expected = { ...baseline }
  for (const old of [
    ...Object.values(MOVED_FROM_BASELINE),
    ...Object.values(REMOVED_FROM_BASELINE)
  ]) {
    expected[old] -= 1
  }
  return expected
}

export function rows(value: RecordedValue): Record<string, RecordedValue>[] {
  if (!Array.isArray(value)) {
    throw new Error('Missing reviewed recorded rows')
  }
  return value.map((row) => {
    if (!isKeyedObject(row)) {
      throw new Error('Missing reviewed recorded row')
    }
    return row
  })
}

import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../../src/shared/github/work-item-target'
import { GITHUB_CONNECTION_CHANGED } from '../../transport/github-target-invocation'
import type { BridgedParityClass } from '../bridged-parity/divergence-classes'
import { isKeyedObject, scriptsAbsentResultReply } from '../bridged-parity/divergence-evidence'
import type { Observation, Recording, RecordingScenario } from './recording-scenario'
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

// Branch-base pins (f2bee638f25) of members moved to direct judging; unpinned ones await their baseline replay.
export const MOVED_FROM_BASELINE: Readonly<Record<string, BaselineClass | 'old-class-pending'>> = {
  'matrix-github.pr-read-github.listassignableusers-1': 'old-class-pending',
  'matrix-github.pr-read-github.prcheckdetails-1': 'old-class-pending',
  'matrix-github.pr-read-github.prchecks-1': 'old-class-pending',
  'matrix-github.pr-read-github.prforbranch-1': 'old-class-pending',
  'matrix-github.pr-read-github.reposlug-1': 'old-class-pending',
  'matrix-github.pr-read-github.workitemdetails-1': 'old-class-pending',
  'matrix-github.pr-read-hostedreview.forbranch-1': 'old-class-pending',
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
  'pr-read-surface': 'old-class-pending',
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

export function expectedUnchangedTally(baseline: Readonly<Record<BaselineClass, number>>): {
  expected: Record<BaselineClass, number>
  pending: string[]
} {
  const expected = { ...baseline }
  const pending: string[] = []
  for (const [id, old] of [
    ...Object.entries(MOVED_FROM_BASELINE),
    ...Object.entries(REMOVED_FROM_BASELINE)
  ]) {
    if (old === 'old-class-pending') {
      pending.push(id)
    } else {
      expected[old] -= 1
    }
  }
  return { expected, pending }
}

export const BRIDGE_REPLY_REFUSED = 'the reply could not be read (unrecognised-message)'

const unreadable = (method: string) => `The host sent a reply this app could not read (${method})`

// The GitHub exact-target check maps its own failures: natively an unreadable answer says to update the server,
// while the page's refusal of that frame is a failed transport check, which says the connection changed.
const GITHUB_CHECK_COPIES = [unreadable('status.get'), GITHUB_EXACT_OPERATION_UNSUPPORTED]
const GITHUB_CHECK_PAGE_COPY = GITHUB_CONNECTION_CHANGED

function refusedError(): RecordedValue {
  return {
    category: 'BridgeReplyRefusedError',
    message: BRIDGE_REPLY_REFUSED,
    isRpcDeliveryUnknown: true
  }
}

function substitute(value: RecordedValue, copied: ReadonlyMap<string, string>): RecordedValue {
  if (typeof value === 'string') {
    return copied.get(value) ?? value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => substitute(entry, copied))
  }
  if (!isKeyedObject(value)) {
    return value
  }
  if (
    value.category === 'RpcIncompatibleReplyError' &&
    typeof value.message === 'string' &&
    copied.get(value.message) === BRIDGE_REPLY_REFUSED &&
    value.code === 'incompatible_reply' &&
    value.isRpcDeliveryUnknown === false &&
    Object.keys(value).length === 4
  ) {
    return refusedError()
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, substitute(entry, copied)])
  )
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

// The page refuses the injected { ok: true } reply that the native reader rejects as unreadable: the bound caller
// rejects with the bridge refusal, and the product shows that error where it showed the native one. Everything
// else is the reviewed native golden, so a shorter page prefix or any other difference still fails.
function refusedObservation(observation: Observation): Observation {
  const copied = new Map<string, string>()
  const sender = rows(observation.sender).map((attempt): RecordedValue => {
    const settlement = attempt.settlement
    if (
      !isKeyedObject(settlement) ||
      settlement.status !== 'fulfilled' ||
      !isKeyedObject(settlement.value) ||
      settlement.value.ok !== true ||
      Object.hasOwn(settlement.value, 'result')
    ) {
      return attempt
    }
    const method = String(attempt.name).replace(/#.*$/, '')
    if (method === 'status.get') {
      for (const copy of GITHUB_CHECK_COPIES) {
        copied.set(copy, GITHUB_CHECK_PAGE_COPY)
      }
    } else {
      copied.set(unreadable(method), BRIDGE_REPLY_REFUSED)
    }
    const { value: _value, ...timing } = settlement
    return { ...attempt, settlement: { ...timing, status: 'rejected', error: refusedError() } }
  })
  if (!copied.size) {
    return observation
  }
  return {
    ...observation,
    sender,
    settlements: substitute(observation.settlements, copied),
    state: substitute(observation.state, copied),
    effects: substitute(observation.effects, copied)
  }
}

export function refusedReplyExpectation(
  expected: Recording,
  scenarios: readonly RecordingScenario[]
): Recording {
  return {
    ...expected,
    checkpoints: expected.checkpoints.map((checkpoint) => {
      const source =
        scenarios.length === 1
          ? scenarios[0]
          : scenarios.find((scenario) => checkpoint.id.startsWith(`${scenario.id}:`))
      if (!source) {
        throw new Error(`Checkpoint has no input scenario: ${checkpoint.id}`)
      }
      return scriptsAbsentResultReply(source)
        ? { ...checkpoint, observation: refusedObservation(checkpoint.observation) }
        : checkpoint
    })
  }
}

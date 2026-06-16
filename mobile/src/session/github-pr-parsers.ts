import type {
  GitHubAssignableUser,
  GitHubPRReviewSummary,
  GitHubWorkItem,
  GitHubWorkItemDetails,
  PRCheckAnnotation,
  PRCheckDetail,
  PRCheckJob,
  PRCheckRunDetails,
  PRCheckStep,
  PRInfo
} from '../../../src/shared/types'
import type { HostedReviewInfo } from '../../../src/shared/hosted-review'
import {
  isRecord,
  readAssignableUserArray,
  readBoolean,
  readCheckRunConclusion,
  readCheckRunStatus,
  readCheckStatus,
  readCheckSummary,
  readMergeableState,
  readMergeMethodSettings,
  readNumber,
  readPRState,
  readProvider,
  readRepoIdentity,
  readReviewDecision,
  readReviewSummary,
  readString,
  readStringArray
} from './github-pr-value-readers'

// Defensive entity parsers for the github.* / hostedReview.* PR reads. Each
// returns null (or an empty collection) on unparseable input rather than throwing.

export function readForBranch(value: unknown): HostedReviewInfo | null {
  if (!isRecord(value)) {
    return null
  }
  const provider = readProvider(value.provider)
  const number = readNumber(value.number)
  const title = readString(value.title)
  const url = readString(value.url)
  const updatedAt = readString(value.updatedAt)
  // Why: the gate decides on provider/number; bail only when the core identity
  // is unparseable rather than throwing on partial payloads.
  if (provider === undefined || number === undefined) {
    return null
  }
  const state = value.state
  return {
    provider,
    number,
    title: title ?? '',
    state:
      state === 'open' || state === 'closed' || state === 'merged' || state === 'draft'
        ? state
        : 'open',
    url: url ?? '',
    status: readCheckStatus(value.status),
    updatedAt: updatedAt ?? '',
    mergeable: readMergeableState(value.mergeable) ?? 'UNKNOWN',
    reviewDecision: readReviewDecision(value.reviewDecision),
    autoMergeEnabled: readBoolean(value.autoMergeEnabled),
    autoMergeAllowed:
      value.autoMergeAllowed === null ? null : (readBoolean(value.autoMergeAllowed) ?? undefined),
    mergeStateStatus: value.mergeStateStatus === null ? null : readString(value.mergeStateStatus),
    headSha: readString(value.headSha)
  }
}

export function readPRForBranch(value: unknown): PRInfo | null {
  if (!isRecord(value)) {
    return null
  }
  const number = readNumber(value.number)
  const state = readPRState(value.state)
  if (number === undefined || state === null) {
    return null
  }
  return {
    number,
    title: readString(value.title) ?? '',
    state,
    url: readString(value.url) ?? '',
    checksStatus: readCheckStatus(value.checksStatus),
    updatedAt: readString(value.updatedAt) ?? '',
    mergeable: readMergeableState(value.mergeable) ?? 'UNKNOWN',
    reviewDecision: readReviewDecision(value.reviewDecision),
    autoMergeEnabled: readBoolean(value.autoMergeEnabled),
    autoMergeAllowed:
      value.autoMergeAllowed === null ? null : (readBoolean(value.autoMergeAllowed) ?? undefined),
    mergeQueueRequired:
      value.mergeQueueRequired === null
        ? null
        : (readBoolean(value.mergeQueueRequired) ?? undefined),
    mergeStateStatus: value.mergeStateStatus === null ? null : readString(value.mergeStateStatus),
    headSha: readString(value.headSha),
    // prRepo identifies a fork PR's head repo; checks/merge are keyed on it.
    prRepo: readRepoIdentity(value.prRepo),
    // mergeMethodSettings drives which merge methods the picker may offer.
    mergeMethodSettings: readMergeMethodSettings(value.mergeMethodSettings)
  }
}

function readWorkItem(value: unknown): Omit<GitHubWorkItem, 'repoId'> | null {
  if (!isRecord(value)) {
    return null
  }
  const id = readString(value.id)
  const number = readNumber(value.number)
  const type = value.type === 'issue' || value.type === 'pr' ? value.type : null
  const state = readPRState(value.state)
  if (id === undefined || number === undefined || type === null || state === null) {
    return null
  }
  return {
    id,
    type,
    number,
    title: readString(value.title) ?? '',
    state,
    url: readString(value.url) ?? '',
    labels: readStringArray(value.labels),
    updatedAt: readString(value.updatedAt) ?? '',
    author: readString(value.author) ?? null,
    branchName: readString(value.branchName),
    baseRefName: readString(value.baseRefName),
    headSha: readString(value.headSha),
    reviewDecision: readReviewDecision(value.reviewDecision),
    reviewRequests: readAssignableUserArray(value.reviewRequests),
    latestReviews: Array.isArray(value.latestReviews)
      ? value.latestReviews.flatMap((entry): GitHubPRReviewSummary[] => {
          const parsed = readReviewSummary(entry)
          return parsed ? [parsed] : []
        })
      : undefined,
    assignees: readAssignableUserArray(value.assignees),
    checksSummary: readCheckSummary(value.checksSummary),
    mergeable: readMergeableState(value.mergeable),
    autoMergeEnabled: readBoolean(value.autoMergeEnabled),
    mergeStateStatus: value.mergeStateStatus === null ? null : readString(value.mergeStateStatus)
  }
}

export function readWorkItemDetails(value: unknown): GitHubWorkItemDetails | null {
  if (!isRecord(value)) {
    return null
  }
  const item = readWorkItem(value.item)
  if (!item) {
    return null
  }
  return {
    item,
    body: readString(value.body) ?? '',
    comments: [],
    headSha: readString(value.headSha),
    baseSha: readString(value.baseSha),
    pullRequestId: readString(value.pullRequestId),
    checks: readPRChecks(value.checks),
    participants: readAssignableUserArray(value.participants),
    assignees: Array.isArray(value.assignees) ? readStringArray(value.assignees) : undefined
  }
}

function readCheckDetail(value: unknown): PRCheckDetail | null {
  if (!isRecord(value)) {
    return null
  }
  const name = readString(value.name)
  const status = readCheckRunStatus(value.status)
  if (name === undefined || status === null) {
    return null
  }
  return {
    name,
    status,
    conclusion: readCheckRunConclusion(value.conclusion),
    url: readString(value.url) ?? null,
    checkRunId: readNumber(value.checkRunId),
    workflowRunId: readNumber(value.workflowRunId)
  }
}

export function readPRChecks(value: unknown): PRCheckDetail[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry): PRCheckDetail[] => {
    const parsed = readCheckDetail(entry)
    return parsed ? [parsed] : []
  })
}

function readCheckAnnotation(value: unknown): PRCheckAnnotation | null {
  if (!isRecord(value)) {
    return null
  }
  return {
    path: readString(value.path) ?? null,
    startLine: readNumber(value.startLine) ?? null,
    endLine: readNumber(value.endLine) ?? null,
    annotationLevel: readString(value.annotationLevel) ?? null,
    title: readString(value.title) ?? null,
    message: readString(value.message) ?? '',
    rawDetails: readString(value.rawDetails) ?? null
  }
}

function readCheckStep(value: unknown): PRCheckStep | null {
  if (!isRecord(value)) {
    return null
  }
  return {
    name: readString(value.name) ?? '',
    status: readString(value.status) ?? null,
    conclusion: readString(value.conclusion) ?? null,
    startedAt: readString(value.startedAt) ?? null,
    completedAt: readString(value.completedAt) ?? null
  }
}

function readCheckJob(value: unknown): PRCheckJob | null {
  if (!isRecord(value)) {
    return null
  }
  return {
    id: readNumber(value.id) ?? null,
    name: readString(value.name) ?? '',
    status: readString(value.status) ?? null,
    conclusion: readString(value.conclusion) ?? null,
    startedAt: readString(value.startedAt) ?? null,
    completedAt: readString(value.completedAt) ?? null,
    url: readString(value.url) ?? null,
    logTail: readString(value.logTail) ?? null,
    steps: Array.isArray(value.steps)
      ? value.steps.flatMap((entry): PRCheckStep[] => {
          const parsed = readCheckStep(entry)
          return parsed ? [parsed] : []
        })
      : []
  }
}

export function readPRCheckDetails(value: unknown): PRCheckRunDetails | null {
  if (!isRecord(value)) {
    return null
  }
  const name = readString(value.name)
  if (name === undefined) {
    return null
  }
  return {
    name,
    status: readString(value.status) ?? null,
    conclusion: readString(value.conclusion) ?? null,
    url: readString(value.url) ?? null,
    detailsUrl: readString(value.detailsUrl) ?? null,
    startedAt: readString(value.startedAt) ?? null,
    completedAt: readString(value.completedAt) ?? null,
    title: readString(value.title) ?? null,
    summary: readString(value.summary) ?? null,
    text: readString(value.text) ?? null,
    annotations: Array.isArray(value.annotations)
      ? value.annotations.flatMap((entry): PRCheckAnnotation[] => {
          const parsed = readCheckAnnotation(entry)
          return parsed ? [parsed] : []
        })
      : [],
    jobs: Array.isArray(value.jobs)
      ? value.jobs.flatMap((entry): PRCheckJob[] => {
          const parsed = readCheckJob(entry)
          return parsed ? [parsed] : []
        })
      : []
  }
}

export function readAssignableUsers(value: unknown): GitHubAssignableUser[] {
  return readAssignableUserArray(value)
}

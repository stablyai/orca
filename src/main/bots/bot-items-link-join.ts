// An item's links joined with live state, read-only: each linked Dispatch by its lineage's newest
// worker with its times and report, PRs and issues from the host's GitHub caches (PRs with the cache's
// own read time).
import {
  botItemPrRefOfUrl,
  botItemPrUrl,
  type BotItemIssue,
  type BotItemLinkView,
  type BotItemPullRequest,
  type BotItemWorkerState
} from '../../shared/bots/bot-items'
import type { Automation } from '../../shared/automations/automation-definition'
import type { IssueInfo, PRInfo } from '../../shared/github/pull-requests/pull-request-types'
import type { BotItemLinkRecord } from './bot-items-schema'
import type { BotWorkWorker } from './bot-work-types'
import { workspaceReader, type BotWorkRuntime } from './bot-work-runtime'
import { LinkedWorkerStates, type LinkedWorkerState } from './bot-items-linked-worker-states'

type CacheRecord<T> = Readonly<Record<string, { data: T | null; fetchedAt: number }>>

export type BotItemGitHubCache = () => { pr: CacheRecord<PRInfo>; issue: CacheRecord<IssueInfo> }

/** The host's automations, read on use. */
export type BotItemAutomations = () => readonly Pick<Automation, 'id' | 'name' | 'enabled'>[]

type CacheEntry<T> = { data: T; fetchedAt: number }

/** A cache's entries by URL, indexed once per cache record instead of scanned per link: the host
 *  replaces a record on each write, so an index kept per record object stays current. */
function urlIndex<T extends { url: string }>(key: (url: string) => string) {
  const indexes = new WeakMap<object, Map<string, CacheEntry<T>>>()
  return (record: CacheRecord<T>): ReadonlyMap<string, CacheEntry<T>> => {
    let index = indexes.get(record)
    if (!index) {
      index = new Map()
      for (const entry of Object.values(record)) {
        if (entry.data && !index.has(key(entry.data.url))) {
          index.set(key(entry.data.url), { data: entry.data, fetchedAt: entry.fetchedAt })
        }
      }
      indexes.set(record, index)
    }
    return index
  }
}

const prsByUrl = urlIndex<PRInfo>((url) => url)
const issuesByUrl = urlIndex<IssueInfo>((url) => url.toLowerCase())

export type WorkerRead = LinkedWorkerState & { pr: BotItemPullRequest | null }

export class BotItemLinkJoin {
  private readonly states: LinkedWorkerStates

  constructor(
    private readonly workRuntime: BotWorkRuntime,
    private readonly githubCache: BotItemGitHubCache,
    private readonly automations: BotItemAutomations = () => []
  ) {
    this.states = new LinkedWorkerStates(workRuntime)
  }

  /** Each linked Dispatch's worker in one batch, so a follow-up still shows on the item.
   *  `pullRequests: false` skips the workspace and PR reads, for a caller that only needs states. */
  async readLinkedWorkers(
    refs: readonly string[],
    { pullRequests = true }: { pullRequests?: boolean } = {}
  ): Promise<Map<string, WorkerRead>> {
    const unique = [...new Set(refs)]
    const reads = new Map<string, WorkerRead>()
    if (unique.length === 0) {
      return reads
    }
    let states: Map<string, LinkedWorkerState | null>
    try {
      states = await this.states.readStates(unique)
    } catch (error) {
      // Orchestration unreadable: every link reads `unknown`, never success or failure.
      console.warn('[bots] items: could not read linked workers', error)
      return reads
    }
    // Links to one worker (a Dispatch and its follow-ups) read its workspace once; every workspace here
    // reads its repo's worktrees and checks each path once, not once per worker.
    const readWorkspace = workspaceReader(this.workRuntime, new Map(), new Map())
    const prs = new Map<string, Promise<BotItemPullRequest | null>>()
    await Promise.all(
      unique.map(async (ref) => {
        // Left out: it couldn't be read, so its link reads `unknown`.
        if (!states.has(ref)) {
          return
        }
        const state = states.get(ref) ?? null
        if (!state?.worker) {
          reads.set(ref, { worker: null, pr: null, report: null })
          return
        }
        const { worker } = state
        let pr = prs.get(worker.dispatchId)
        if (!pr) {
          pr = pullRequests ? this.workerPr(worker, readWorkspace) : Promise.resolve(null)
          prs.set(worker.dispatchId, pr)
        }
        reads.set(ref, { ...state, pr: await pr })
      })
    )
    return reads
  }

  /** A write to these Dispatches' rows, or a paired server's verdict on them: their kept reads go, and
   *  a read running now keeps nothing it read. */
  workersWritten(dispatchIds: readonly string[] = []): void {
    this.states.noteWrite(dispatchIds)
  }

  /** Server-hosted work shows no PR state until a remote PR read exists. */
  private async workerPr(
    worker: BotWorkWorker,
    readWorkspace: ReturnType<typeof workspaceReader>
  ): Promise<BotItemPullRequest | null> {
    if (worker.host !== 'local') {
      return { shown: false, reason: 'server' }
    }
    const workspace = await readWorkspace(worker).catch(() => null)
    const pr = workspace && workspace !== 'gone' ? workspace.pullRequest : null
    if (!pr) {
      return null
    }
    const cached = this.cacheEntryByUrl(pr.url)
    return {
      shown: true,
      ref: botItemPrRefOfUrl(pr.url) ?? pr.url,
      number: pr.number,
      url: pr.url,
      state: pr.state,
      checks: pr.checks,
      review: pr.review,
      title: cached?.data.title ?? null,
      checkedAt: cached?.fetchedAt ?? null,
      worktreeId: worker.worktreeId
    }
  }

  private cacheEntryByUrl(url: string): CacheEntry<PRInfo> | null {
    return prsByUrl(this.githubCache().pr).get(url) ?? null
  }

  /** A `pr:` link with no worker, matched against the cache by URL; no match shows a plain link. */
  private explicitPr(ref: string): BotItemPullRequest | null {
    const url = botItemPrUrl(ref)
    const entry = url ? this.cacheEntryByUrl(url) : null
    return entry
      ? {
          shown: true,
          ref,
          number: entry.data.number,
          url: entry.data.url,
          state: entry.data.state,
          checks: entry.data.checksStatus ?? null,
          review: entry.data.reviewDecision ?? null,
          title: entry.data.title,
          checkedAt: entry.fetchedAt
        }
      : null
  }

  /** A GitHub issue link's title and state, when the issue cache has read it. */
  private cachedIssue(url: string): BotItemIssue | null {
    const match = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)(?:[/?#].*)?$/i.exec(
      url.trim()
    )
    if (!match) {
      return null
    }
    const canonical = `https://github.com/${match[1]}/issues/${match[2]}`.toLowerCase()
    const entry = issuesByUrl(this.githubCache().issue).get(canonical)
    return entry ? { title: entry.data.title, state: entry.data.state } : null
  }

  linkView(link: BotItemLinkRecord, read: WorkerRead | undefined): BotItemLinkView {
    switch (link.kind) {
      case 'dispatch': {
        const worker = read?.worker ?? null
        return {
          kind: 'dispatch',
          ref: link.ref,
          latest: worker && worker.dispatchId !== link.ref ? worker.dispatchId : null,
          title: worker?.title ?? null,
          state: read ? workerState(worker) : 'unknown',
          // A paired server's released worker also has no handle, though it ran.
          ...(worker?.startFailed && worker.host === 'local'
            ? { neverStarted: true as const }
            : {}),
          host: worker?.hostName ?? (worker && worker.host !== 'local' ? worker.host : null),
          startedAt: worker?.startedAt ?? null,
          settledAt: worker?.settledAt ?? null,
          report: read?.report ?? null,
          reason: read?.reason ?? null,
          pr: read?.pr ?? null
        }
      }
      case 'pr':
        return { kind: 'pr', ref: link.ref, pr: this.explicitPr(link.ref) }
      case 'url': {
        // A PR URL kept as a plain link is still that PR, with its cached state.
        const pr = botItemPrRefOfUrl(link.ref)
        if (pr) {
          return { kind: 'pr', ref: pr, pr: this.explicitPr(pr) }
        }
        const issue = this.cachedIssue(link.ref)
        return issue ? { kind: 'url', ref: link.ref, issue } : { kind: 'url', ref: link.ref }
      }
      case 'file':
        return { kind: link.kind, ref: link.ref }
      case 'automation': {
        // A wait is deleted once it has run, so a gone one wakes nobody.
        const automation = this.automations().find((entry) => entry.id === link.ref)
        return {
          kind: 'automation',
          ref: link.ref,
          name: automation?.name ?? null,
          active: automation?.enabled === true
        }
      }
    }
  }
}

function workerState(worker: BotWorkWorker | null): BotItemWorkerState {
  if (!worker) {
    return 'missing'
  }
  if (worker.startFailed) {
    return 'failed'
  }
  if (worker.stopped) {
    return 'stopped'
  }
  return worker.state === 'unverifiable' ? 'unknown' : worker.state
}

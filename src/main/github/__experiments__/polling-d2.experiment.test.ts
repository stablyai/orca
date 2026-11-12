/**
 * DISPOSABLE EXPERIMENT (STA-8667 design rounds D2/D3). Lives only on the harness branch
 * AmethystLiang/sta-8667-polling-harness; never merge. See RUN.md.
 *
 * Simulated time (vitest fake timers). Real production code under test:
 *   - desktop: coordinator, queue, drainer, pacing, visibility, rate-limit gate, lookup pipeline.
 *   - serve:   runHostedPRRead + getPRForBranchOutcome, real renderer scheduler module.
 * Replaced: the `gh` and `git` subprocess boundaries (recorders with canned answers).
 *
 * D3 is AUTOMATIC ONLY: there is no cadence setting anywhere in this file. "before" scenarios
 * are the code as checked out; "after" scenarios prototype the D3 proposal next to it:
 *   - B (policy-d3.ts: unchanged-result backoff to fixed caps 30/60 min, completion-based
 *     activity classes incl. complete-empty = settled, rich signature) via a partial mock of
 *     pr-refresh-candidate-policy (desktop) and a host store (serve).
 *   - C (gate-d3.ts: non-blocking admission gate with reserved lanes) in `createHostAfter`,
 *     with the 10 s reply deadline, the per-client interactive limit and ungated legacy clients.
 *   - D (rate-limit snapshot reused until its reset) via a wrapper around getRateLimit. This is
 *     a MODEL of the probe count only; the per-resource rule has its own probe file.
 *   - E (no focused window for 5 min pauses non-selected rows).
 *   - client contract: real scheduler source plus the d3 patch set (scheduler-patches.ts) and
 *     the hint store.
 *
 * Env: EXP_SCENARIO desktop-before|desktop-after|serve-before|serve-after|serve-after-oldclient
 *      EXP_HOST ghes|dotcom, EXP_N, EXP_CLIENTS, EXP_HOURS, EXP_WORKLOAD settled|mixed,
 *      EXP_FOCUS focused|unfocused|hidden|return, EXP_IDLE pause|none, EXP_JITTER (0..0.25),
 *      EXP_EVENTS 0|1 (external CI start/finish events), EXP_EVENT_TARGETS, EXP_SEED,
 *      EXP_STAGGER_S, EXP_DISJOINT (serve: last client sees 5 rows nobody else sees),
 *      EXP_NOCI 1|0 (default 1: some PRs have no CI at all; 0 = the D2 world),
 *      EXP_GATE d3|d2 (serve-after: which admission gate; d2 = the frozen D2 gate, "before"),
 *      EXP_SELECTED_IDS n (serve: clients 1..n each select a different PR with running CI),
 *      EXP_SELECTED_RUNNING 1 (serve: with one selected identity, make it a PR with running CI
 *        instead of the settled row 0),
 *      EXP_CHECKS 1 (serve: every client also runs a Checks-panel timed read of its selected PR),
 *      EXP_SLOW_EVERY k + EXP_SLOW_MS (every k-th PR read upstream takes that long),
 *      EXP_DISCONNECT_MIN m (serve: client 1 disappears at minute m without saying so),
 *      EXP_ALL_GONE_MIN m (serve: every client disappears at minute m),
 *      EXP_FG_EVERY_S s (serve: every client sends a foreground read of its selected PR every s),
 *      EXP_OUT
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { it, vi } from 'vitest'
import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../shared/github/pull-request-refresh-types'

const cfg = vi.hoisted(() => ({
  scenario: process.env.EXP_SCENARIO ?? 'desktop-before',
  host: process.env.EXP_HOST ?? 'ghes',
  n: Number(process.env.EXP_N ?? 10),
  clients: Number(process.env.EXP_CLIENTS ?? 1),
  hours: Number(process.env.EXP_HOURS ?? 1),
  workload: process.env.EXP_WORKLOAD ?? 'settled',
  focus: process.env.EXP_FOCUS ?? 'focused',
  idle: process.env.EXP_IDLE ?? 'pause',
  jitter: Number(process.env.EXP_JITTER ?? 0),
  events: process.env.EXP_EVENTS === '1',
  staggerS: Number(process.env.EXP_STAGGER_S ?? 25),
  disjoint: process.env.EXP_DISJOINT === '1',
  seed: Number(process.env.EXP_SEED ?? 1),
  eventTargets: Number(process.env.EXP_EVENT_TARGETS ?? 7),
  noci: process.env.EXP_NOCI !== '0',
  gate: (process.env.EXP_GATE ?? 'd3') as 'd2' | 'd3',
  selectedIds: Number(process.env.EXP_SELECTED_IDS ?? 1),
  selectedRunning: process.env.EXP_SELECTED_RUNNING === '1',
  checks: process.env.EXP_CHECKS === '1',
  slowEvery: Number(process.env.EXP_SLOW_EVERY ?? 0),
  slowMs: Number(process.env.EXP_SLOW_MS ?? 25_000),
  disconnectMin: process.env.EXP_DISCONNECT_MIN ? Number(process.env.EXP_DISCONNECT_MIN) : null,
  allGoneMin: process.env.EXP_ALL_GONE_MIN ? Number(process.env.EXP_ALL_GONE_MIN) : null,
  fgEveryS: Number(process.env.EXP_FG_EVERY_S ?? 0)
}))

const IDLE_AFTER_MS = 5 * 60_000

type PRWorld = {
  head: string
  state: 'OPEN' | 'MERGED'
  branch: string
  // per-check state; "running" keeps `build` in progress, "failed-running" adds a failed check,
  // "none" is a repository with no CI: a complete, empty rollup (D2-3).
  checks: 'done' | 'running' | 'failed-running' | 'none'
}

const rec = vi.hoisted(() => {
  return {
    gh: [] as { t: number; kind: string; host: string }[],
    git: [] as { t: number; argv: string[] }[],
    unknownGit: new Set<string>(),
    unknownGh: new Set<string>(),
    prs: new Map<number, PRWorld>(),
    branchToPR: new Map<string, number>(),
    prReads: 0,
    t0: 0
  }
})

function ghKind(argv: string[]): string {
  const joined = argv.join(' ')
  if (argv[0] === 'api' && argv[1] === 'rate_limit') return 'api:rate_limit'
  if (argv[0] === 'api' && argv[1] === 'graphql') {
    if (joined.includes('stackEntry')) return 'graphql:sidebar'
    if (joined.includes('viewerDefaultMergeMethod')) return 'graphql:merge-metadata'
    if (joined.includes('commits(last: 1)')) return 'graphql:checks'
    return 'graphql:other'
  }
  if (argv[0] === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\?/.test(argv[1] ?? '')) return 'rest:pulls-by-head'
  if (argv[0] === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(argv[1] ?? '')) return 'rest:pull'
  if (argv[0] === 'api' && /commits/.test(argv[1] ?? '')) return 'rest:pr-commits'
  if (argv[0] === 'api') return `api:${argv[1]}`
  if (argv[0] === 'pr' && argv[1] === 'view') return 'pr:view'
  if (argv[0] === 'pr' && argv[1] === 'list') return 'pr:list'
  if (argv[0] === 'auth' && argv[1] === 'status') return 'auth:status'
  return `other:${argv.slice(0, 2).join(' ')}`
}

function flag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length - 1; i++) {
    if (['-f', '-F'].includes(argv[i]) && argv[i + 1].startsWith(`${name}=`)) {
      return argv[i + 1].slice(name.length + 1)
    }
    if (argv[i] === '-H' && argv[i + 1].toLowerCase().startsWith(`${name.toLowerCase()}:`)) {
      return argv[i + 1].slice(name.length + 1).trim()
    }
  }
  return undefined
}

const WEB_HOST = cfg.host === 'ghes' ? 'ghe.example.com' : 'github.com'

function checkNodes(checks: PRWorld['checks']) {
  if (checks === 'none') return []
  const nodes: Record<string, unknown>[] = [
    {
      __typename: 'CheckRun',
      name: 'build',
      databaseId: 1,
      status: checks === 'done' ? 'COMPLETED' : 'IN_PROGRESS',
      conclusion: checks === 'done' ? 'SUCCESS' : null,
      checkSuite: { databaseId: 11 }
    },
    {
      __typename: 'CheckRun',
      name: 'test',
      databaseId: 2,
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      checkSuite: { databaseId: 11 }
    }
  ]
  if (checks === 'failed-running') {
    nodes.push({
      __typename: 'CheckRun',
      name: 'lint',
      databaseId: 3,
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      checkSuite: { databaseId: 11 }
    })
  }
  return nodes
}

function commits(pr: PRWorld) {
  return {
    nodes: [
      {
        commit: {
          oid: pr.head,
          statusCheckRollup: {
            contexts: {
              nodes: checkNodes(pr.checks),
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          },
          checkSuites: {
            nodes: pr.checks === 'none' ? [] : [{ databaseId: 11, conclusion: pr.checks === 'done' ? 'SUCCESS' : null }],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }
    ]
  }
}

function prFields(number: number, pr: PRWorld) {
  return {
    number,
    title: `PR ${number}`,
    state: pr.state,
    url: `https://${WEB_HOST}/acme/fixture/pull/${number}`,
    updatedAt: '2026-11-10T00:00:00Z',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    mergeStateStatus: 'CLEAN',
    autoMergeRequest: null,
    baseRefName: 'main',
    headRefName: pr.branch,
    baseRefOid: 'b'.repeat(40),
    headRefOid: pr.head,
    isCrossRepository: false,
    headRepositoryOwner: { login: 'acme' },
    headRepository: { name: 'fixture' }
  }
}

function restPR(number: number) {
  const pr = rec.prs.get(number)!
  return {
    number,
    title: `PR ${number}`,
    state: pr.state === 'MERGED' ? 'closed' : 'open',
    html_url: `https://${WEB_HOST}/acme/fixture/pull/${number}`,
    updated_at: '2026-11-10T00:00:00Z',
    draft: false,
    merged_at: pr.state === 'MERGED' ? '2026-11-10T00:00:00Z' : null,
    mergeable: true,
    mergeable_state: 'clean',
    base: { ref: 'main', sha: 'b'.repeat(40) },
    head: {
      ref: pr.branch,
      sha: pr.head,
      repo: { name: 'fixture', owner: { login: 'acme' }, default_branch: 'main' }
    }
  }
}

function httpResponse(status: number, body: string, etag: string): string {
  return `HTTP/2.0 ${status} ${status === 200 ? 'OK' : 'Not Modified'}\r\netag: ${etag}\r\ncontent-type: application/json\r\n\r\n${body}`
}

function etagged(argv: string[], body: string) {
  const etag = `W/"${Buffer.from(body).toString('base64').slice(0, 24)}${body.length}"`
  if (flag(argv, 'If-None-Match') === etag) {
    throw Object.assign(new Error('gh: HTTP 304'), {
      code: 1,
      stdout: httpResponse(304, '', etag),
      stderr: 'gh: HTTP 304'
    })
  }
  return { stdout: httpResponse(200, body, etag), stderr: '' }
}

async function fakeGh(argv: string[], options: { host?: string; env?: Record<string, string> } = {}) {
  const kind = ghKind(argv)
  const host = kind === 'api:rate_limit' ? (options.host ?? 'github.com') : WEB_HOST
  rec.gh.push({ t: Date.now() - rec.t0, kind, host })
  // One gh call takes ~0.4 s of simulated time. EXP_SLOW_EVERY makes every k-th PR read slow.
  let took = 400
  if (kind === 'graphql:sidebar' || kind === 'pr:view') {
    rec.prReads += 1
    if (cfg.slowEvery > 0 && rec.prReads % cfg.slowEvery === 0) took = cfg.slowMs
  }
  await new Promise((r) => setTimeout(r, took))
  switch (kind) {
    case 'api:rate_limit': {
      const reset = Math.floor(Date.now() / 1000 / 3600) * 3600 + 3600
      const b = { limit: 5000, remaining: 4900, reset }
      return {
        stdout: JSON.stringify({ resources: { core: b, graphql: b, search: { ...b, limit: 30, remaining: 30 } } }),
        stderr: ''
      }
    }
    case 'graphql:sidebar': {
      const number = Number(flag(argv, 'number'))
      const pr = rec.prs.get(number)
      if (!pr) {
        return {
          stdout: JSON.stringify({
            data: { repository: { pullRequest: null } },
            errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'] }]
          }),
          stderr: ''
        }
      }
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: { ...prFields(number, pr), commits: commits(pr), stack: null, stackEntry: null }
            }
          }
        }),
        stderr: ''
      }
    }
    case 'pr:view': {
      const number = Number(argv[2])
      const pr = rec.prs.get(number)
      if (!pr) {
        throw Object.assign(new Error('no pull requests found'), {
          code: 1,
          stderr: 'GraphQL: Could not resolve to a PullRequest with the number'
        })
      }
      return { stdout: JSON.stringify(prFields(number, pr)), stderr: '' }
    }
    case 'graphql:checks': {
      const number = Number(flag(argv, 'number'))
      const pr = rec.prs.get(number)!
      return {
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { number, headRefOid: pr.head, commits: commits(pr) } } }
        }),
        stderr: ''
      }
    }
    case 'graphql:merge-metadata':
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              viewerDefaultMergeMethod: 'SQUASH',
              mergeCommitAllowed: true,
              rebaseMergeAllowed: true,
              squashMergeAllowed: true,
              autoMergeAllowed: true,
              mergeQueue: null,
              ref: { rules: { nodes: [] } }
            }
          }
        }),
        stderr: ''
      }
    case 'rest:pulls-by-head': {
      const url = new URL(`https://x/${argv[1]}`)
      const head = decodeURIComponent(url.searchParams.get('head') ?? '')
      const branch = head.split(':')[1] ?? head
      const number = rec.branchToPR.get(branch)
      const rows = number && rec.prs.has(number) ? [restPR(number)] : []
      const filtered = url.searchParams.get('state') === 'open' ? rows.filter((r) => r.state === 'open') : rows
      return etagged(argv, JSON.stringify(filtered))
    }
    case 'rest:pull':
      return etagged(argv, JSON.stringify(restPR(Number(argv[1].split('/').pop()))))
    case 'rest:pr-commits':
      return { stdout: '[]', stderr: '' }
    case 'pr:list':
      return { stdout: '[]', stderr: '' }
    case 'auth:status':
      return {
        stdout: `${WEB_HOST}\n  ✓ Logged in to ${WEB_HOST} account dev (keyring)\n  - Active account: true\n  - Token scopes: 'repo'\n`,
        stderr: ''
      }
    default:
      rec.unknownGh.add(argv.join(' ').slice(0, 300))
      throw Object.assign(new Error(`unexpected gh call: ${argv.join(' ')}`), { code: 1, stderr: 'unexpected' })
  }
}

vi.mock('../../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: fakeGh,
  ghExecFileWithScopeAsync: async (argv: string[], options: { host?: string } = {}) => ({
    ...(await fakeGh(argv, options)),
    rateLimitScope: `native::${WEB_HOST}`
  })
}))

vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const remote = `https://${cfg.host === 'ghes' ? 'ghe.example.com' : 'github.com'}/acme/fixture.git`
  return {
    ...actual,
    gitExecFileAsync: async (args: string[], options: { cwd?: string } = {}) => {
      rec.git.push({ t: Date.now() - rec.t0, argv: args })
      const a = args.join(' ')
      const wt = /wt-(\d+)/.exec(options.cwd ?? '')
      const index = wt ? Number(wt[1]) : 0
      if (a.startsWith('remote get-url')) return { stdout: `${remote}\n`, stderr: '' }
      if (a === 'remote') return { stdout: 'origin\n', stderr: '' }
      if (a.startsWith('remote -v')) return { stdout: `origin\t${remote} (fetch)\norigin\t${remote} (push)\n`, stderr: '' }
      if (a.startsWith('config --get-regexp') || a.startsWith('config --get')) {
        throw Object.assign(new Error('exit 1'), { code: 1, stdout: '', stderr: '' })
      }
      if (a.startsWith('rev-parse HEAD')) return { stdout: `${index.toString(16).padStart(40, 'a')}\n`, stderr: '' }
      if (a.startsWith('rev-parse --abbrev-ref') || a.startsWith('for-each-ref')) {
        throw Object.assign(new Error('no upstream'), { code: 128, stdout: '', stderr: 'no upstream' })
      }
      if (a.startsWith('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      rec.unknownGit.add(a.slice(0, 200))
      throw Object.assign(new Error(`unexpected git: ${a}`), { code: 128, stdout: '', stderr: 'unexpected' })
    }
  }
})

vi.mock('../pr-refresh-renderer-port', () => ({
  prRefreshRenderers: () => ({ isRendererOpen: () => true, sendToTrustedUI: () => {} }),
  setPRRefreshRendererPort: () => {}
}))

// B on the desktop path: backoff lives in a host map keyed by refreshKey, so the visibility merge
// (cachedFields whitelist) cannot drop it. Idle pause is applied here too.
vi.mock('../pr-refresh-candidate-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pr-refresh-candidate-policy')>()
  if (cfg.scenario !== 'desktop-after') {
    return actual
  }
  const d2 = await import('./policy-d3')
  const interval = (c: GitHubPRRefreshCandidate): number => {
    if (cfg.idle === 'pause' && d2.idle() && c.isSelected !== true) {
      return Number.POSITIVE_INFINITY
    }
    return d2.interval(actual.refreshKey(c), c.isSelected === true, c.cachedFetchedAt ?? 0, cfg.jitter)
  }
  return {
    ...actual,
    refreshIntervalForCandidate: interval,
    freshRetryAt: (c: GitHubPRRefreshCandidate) =>
      c.cachedFetchedAt == null || actual.hasStaleHead(c) ? null : c.cachedFetchedAt + interval(c),
    shouldSkipFresh: (c: GitHubPRRefreshCandidate, reason: Parameters<typeof actual.shouldSkipFresh>[1]) => {
      if (actual.bypassesFreshnessDelay(reason) || c.cachedFetchedAt == null || actual.hasStaleHead(c)) {
        return false
      }
      return Date.now() - c.cachedFetchedAt < interval(c)
    },
    visibleCandidateAfterOutcome: (c: GitHubPRRefreshCandidate, o: PRRefreshOutcome) => {
      if (o.kind !== 'upstream-error') {
        d2.note(actual.refreshKey(c), o as never)
      }
      return actual.visibleCandidateAfterOutcome(c, o)
    }
  }
})

// D: the snapshot is fed by response headers, so a probe is needed only when there is none or
// its reset time has passed. Modelled as: reuse the last probe result until its reset.
vi.mock('../rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rate-limit')>()
  if (!cfg.scenario.endsWith('after')) {
    return actual
  }
  let last: Awaited<ReturnType<typeof actual.getRateLimit>> | null = null
  return {
    ...actual,
    getRateLimit: async (options?: { force?: boolean }) => {
      if (
        !options?.force &&
        last?.ok &&
        Math.min(last.snapshot.core.resetAt, last.snapshot.graphql.resetAt) * 1000 > Date.now()
      ) {
        return last
      }
      last = await actual.getRateLimit({ force: true })
      return last
    }
  }
})

import { reportVisiblePRRefreshCandidates, runHostedPRRead, addPRRefreshOutcomeObserver } from '../pr-refresh-coordinator'
import { getPRForBranchOutcome } from '../client/lookup/pr-for-branch-outcome'
import { reviewRefreshIntervalMs, REVIEW_REFRESH_COOLDOWN_MS } from '../../../shared/review-refresh-policy'
import { createVisibleHostedReviewRefreshScheduler } from '../../../renderer/src/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler'
import * as d2 from './policy-d3'
import { createGateD2, createGateD3, summarizeGate, rollingPeak, type Gate } from './gate-d3'
import { createHintStore, schedulerFactory, type SchedulerFactory } from './scheduler-patches'

const OUT = process.env.EXP_OUT ?? `/tmp/d2-${cfg.scenario}.json`
const SECONDS = Math.round(cfg.hours * 3600)

let rngState = cfg.seed * 7919 + 13
function rng(): number {
  rngState = (Math.imul(rngState, 1103515245) + 12345) & 0x7fffffff
  return rngState / 0x7fffffff
}

/** Same mix as D1: 80% linked (1 in 5 merged, 1 in 5 long-running CI in the `mixed` workload),
 *  20% branch-only, half of those with a PR discoverable by head. */
function seedWorld(): GitHubPRRefreshCandidate[] {
  const candidates: GitHubPRRefreshCandidate[] = []
  for (let i = 0; i < cfg.n; i++) {
    const number = 100 + i
    const branch = `feat/wt-${i}`
    const head = i.toString(16).padStart(40, 'a')
    const linked = i % 5 !== 4
    const hasPR = linked || i % 10 === 4
    if (hasPR) {
      rec.prs.set(number, {
        head,
        branch,
        state: linked && i % 5 === 3 ? 'MERGED' : 'OPEN',
        // No-CI rows (EXP_NOCI): one open PR in ten (i % 10 === 6) and every second merged PR
        // (i % 10 === 8) have a complete, empty rollup.
        checks:
          cfg.workload === 'mixed' && linked && i % 5 === 2
            ? i % 10 === 2
              ? 'failed-running'
              : 'running'
            : cfg.noci && linked && (i % 10 === 6 || i % 10 === 8)
              ? 'none'
              : 'done'
      })
      rec.branchToPR.set(branch, number)
    }
    candidates.push({
      cacheKey: `/fx/wt-${i}::${branch}`,
      repoKind: 'git',
      repoId: 'fixture-repo',
      repoPath: `/fx/wt-${i}`,
      branch,
      worktreeId: `wt-${i}`,
      currentHeadOid: head,
      linkedPRNumber: linked ? number : null,
      isSelected: i === 0,
      cachedFetchedAt: null
    })
  }
  return candidates
}

// ---------- detection events ----------
type Detection = { pr: number; kind: 'start' | 'finish'; selected: boolean; at: number; host?: number; clients: Record<string, number> }
const detections: Detection[] = []
let openEvents = new Map<number, Detection>()

function isRunningOutcome(o: PRRefreshOutcome): boolean | null {
  if (o.kind !== 'found') return null
  return d2.describe(o as never).running
}

function noteObservation(who: string, prNumber: number, o: PRRefreshOutcome): void {
  const ev = openEvents.get(prNumber)
  const running = isRunningOutcome(o)
  if (!ev || running === null) return
  if ((ev.kind === 'start') !== running) return
  const latency = Date.now() - rec.t0 - ev.at
  if (who === 'host') ev.host ??= latency
  else ev.clients[who] ??= latency
}

function scheduleEvents(candidates: GitHubPRRefreshCandidate[]): void {
  if (!cfg.events) return
  // Open, settled, linked PRs: the selected one (wt-0) and up to 6 visible ones.
  const targets = candidates.filter((c, i) => c.linkedPRNumber != null && [0, 1].includes(i % 5)).slice(0, cfg.eventTargets)
  for (const c of targets) {
    const number = c.linkedPRNumber!
    const loop = (delayMin: number): void => {
      setTimeout(() => {
        const pr = rec.prs.get(number)!
        pr.checks = 'running'
        const ev: Detection = { pr: number, kind: 'start', selected: c.isSelected === true, at: Date.now() - rec.t0, clients: {} }
        detections.push(ev)
        openEvents.set(number, ev)
        setTimeout(() => {
          pr.checks = 'done'
          const fin: Detection = { pr: number, kind: 'finish', selected: c.isSelected === true, at: Date.now() - rec.t0, clients: {} }
          detections.push(fin)
          openEvents.set(number, fin)
          loop(50 + rng() * 30)
        }, (20 + rng() * 10) * 60_000)
      }, delayMin * 60_000)
    }
    loop(40 + rng() * 30)
  }
}

// ---------- serve: host RPC ----------
type Deferred = { kind: 'deferred'; nextRefreshAt: number }
// nextRefreshAt: number = earliest useful timed read; null = the host says "no timed read".
type Reply = (PRRefreshOutcome & { nextRefreshAt?: number | null }) | Deferred
type RpcRequest = {
  c: GitHubPRRefreshCandidate
  clientId: number
  selected?: boolean
  foreground?: boolean
  capable: boolean
  /** Checks-panel read of the same PR: its own read identity, selected lane. */
  checks?: boolean
}

function upstreamRead(c: GitHubPRRefreshCandidate): Promise<PRRefreshOutcome> {
  return runHostedPRRead(
    {
      cacheKey: `${c.repoPath}::${c.branch}`,
      repoKind: 'git',
      repoId: c.repoId,
      repoPath: c.repoPath,
      branch: c.branch,
      connectionId: null,
      linkedPRNumber: c.linkedPRNumber ?? null
    },
    () =>
      getPRForBranchOutcome(c.repoPath, c.branch, c.linkedPRNumber ?? null, null, null, {
        currentHeadOid: c.currentHeadOid,
        localGitExecOptions: { admissionTier: 'background' }
      })
  )
}

/** MODELLED Checks-panel read: one `graphql:checks` spawn, answer built from the fixture world.
 *  The production `github.prChecks` path is not exercised. */
async function upstreamChecksRead(c: GitHubPRRefreshCandidate): Promise<PRRefreshOutcome> {
  const number = c.linkedPRNumber!
  await fakeGh(['api', 'graphql', '-f', 'query=query { commits(last: 1) }', '-F', `number=${number}`])
  const pr = rec.prs.get(number)!
  const pending = pr.checks === 'running' || pr.checks === 'failed-running' ? 1 : 0
  const total = pr.checks === 'none' ? 0 : pr.checks === 'failed-running' ? 3 : 2
  return {
    kind: 'found',
    fetchedAt: Date.now(),
    pr: {
      number,
      state: pr.state === 'MERGED' ? 'merged' : 'open',
      headSha: pr.head,
      checksStatus: pending ? 'pending' : 'success',
      checksSummary: { pending, total, passed: total - pending, failed: 0 },
      checksFinal: total > 0 && pending === 0,
      checksReadComplete: true
    }
  } as unknown as PRRefreshOutcome
}

const rpcStats = {
  hits: 0,
  staleServed: 0,
  deferredCold: 0,
  replyDeadlineHits: 0,
  interactiveOverflow: 0,
  legacyHits: 0,
  legacyReads: 0,
  upstreamStarts: [] as number[],
  rpcMs: [] as number[],
  maxRpcMs: 0
}

const REPLY_DEADLINE_MS = 10_000
const INTERACTIVE_MAX = 3
const INTERACTIVE_WINDOW_MS = 30_000

function createHostAfter() {
  // C: non-blocking admission gate (gate-d3.ts). EXP_GATE=d2 runs the frozen D2 gate instead.
  const gate: Gate = cfg.gate === 'd2' ? createGateD2() : createGateD3()
  // Full read identity as the key; every slot is independent (no single-slot eviction).
  const store = new Map<string, { outcome: PRRefreshOutcome; fetchedAt: number }>()
  const inFlight = new Map<string, Promise<PRRefreshOutcome>>()
  const interactive = new Map<number, number[]>()
  const hintOf = (key: string, selected: boolean, fetchedAt: number): number | null => {
    const iv = d2.interval(key, selected, fetchedAt, cfg.jitter)
    return Number.isFinite(iv) ? fetchedAt + iv : null
  }
  const rpc = async (req: RpcRequest): Promise<Reply> => {
    const started = Date.now()
    const done = <T,>(reply: T): T => {
      const ms = Date.now() - started
      rpcStats.rpcMs.push(ms)
      rpcStats.maxRpcMs = Math.max(rpcStats.maxRpcMs, ms)
      return reply
    }
    const { c } = req
    const key = JSON.stringify([req.checks ? 'checks' : 'pr', c.repoPath, c.branch, c.linkedPRNumber ?? null, c.fallbackPRNumber ?? null, false, c.currentHeadOid ?? null])
    const selected = req.selected === true
    const entry = store.get(key)
    const timed = req.foreground !== true
    const startRead = (): Promise<PRRefreshOutcome> => {
      rpcStats.upstreamStarts.push(Date.now() - rec.t0)
      const read = (req.checks ? upstreamChecksRead(c) : upstreamRead(c)).then((outcome) => {
        inFlight.delete(key)
        if (outcome.kind !== 'upstream-error') {
          const existing = store.get(key)
          if (!existing || existing.fetchedAt <= outcome.fetchedAt) {
            d2.note(key, outcome as never)
            store.set(key, { outcome, fetchedAt: outcome.fetchedAt })
          }
          if (c.linkedPRNumber != null && !req.checks) noteObservation('host', c.linkedPRNumber, outcome)
        }
        return outcome
      })
      inFlight.set(key, read)
      return read
    }

    if (!req.capable) {
      // Legacy client (no `selected` field): not gated, no backoff, no hints. A stored answer is
      // reused only inside the shortest interval such a client can be polling at, so its
      // fetchedAt-must-advance rule keeps seeing new answers.
      const pr = entry?.outcome.kind === 'found' ? entry.outcome.pr : null
      const ttl = entry ? reviewRefreshIntervalMs({ state: pr?.state ?? null, checksStatus: pr?.checksStatus ?? null, hasReview: pr !== null, selected: true }) : 0
      if (timed && entry && (ttl === null || Date.now() - entry.fetchedAt < ttl)) {
        rpcStats.legacyHits += 1
        return done(entry.outcome)
      }
      if (!inFlight.has(key)) rpcStats.legacyReads += 1
      return done(await (inFlight.get(key) ?? startRead()))
    }

    if (timed && entry) {
      const iv = d2.interval(key, selected, entry.fetchedAt, cfg.jitter)
      if (Date.now() < entry.fetchedAt + iv) {
        rpcStats.hits += 1
        return done({ ...entry.outcome, nextRefreshAt: Number.isFinite(iv) ? entry.fetchedAt + iv : null })
      }
    }
    let read = inFlight.get(key)
    if (!read) {
      let lane: 'interactive' | 'selected' | 'visible' = timed ? (selected ? 'selected' : 'visible') : 'interactive'
      if (lane === 'interactive') {
        // 3 interactive reads per 30 s per client; the next one falls into the selected lane.
        const recent = (interactive.get(req.clientId) ?? []).filter((t) => started - t < INTERACTIVE_WINDOW_MS)
        if (recent.length >= INTERACTIVE_MAX) {
          lane = 'selected'
          rpcStats.interactiveOverflow += 1
        } else {
          recent.push(started)
        }
        interactive.set(req.clientId, recent)
      }
      const dueSince = entry ? Math.min(started, hintOf(key, selected, entry.fetchedAt) ?? started) : started
      const admission = gate.request(req.clientId, key, lane, dueSince, true)
      if (!admission.admit) {
        if (entry) {
          rpcStats.staleServed += 1
          return done({ ...entry.outcome, nextRefreshAt: admission.retryAt })
        }
        rpcStats.deferredCold += 1
        return done({ kind: 'deferred', nextRefreshAt: admission.retryAt })
      }
      read = startRead()
    }
    // Reply deadline: the initiator and every joiner wait at most 10 s. The read itself goes on
    // and is stored when it settles; the slot it used is not refunded.
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = Symbol('late')
    const raced = await Promise.race([
      read,
      new Promise<typeof late>((resolve) => {
        timer = setTimeout(() => resolve(late), REPLY_DEADLINE_MS)
      })
    ])
    clearTimeout(timer)
    if (raced === late) {
      rpcStats.replyDeadlineHits += 1
      const retryAt = Date.now() + REVIEW_REFRESH_COOLDOWN_MS
      return done(entry ? { ...entry.outcome, nextRefreshAt: retryAt } : { kind: 'deferred', nextRefreshAt: retryAt })
    }
    const outcome = raced
    if (outcome.kind === 'upstream-error') return done(outcome)
    return done({ ...outcome, nextRefreshAt: hintOf(key, selected, outcome.fetchedAt) })
  }
  return { gate, rpc }
}

// ---------- serve: clients ----------
const clientStats = { refreshCalls: 0, failures: 0, checksCalls: 0, foregroundCalls: 0, hintsDroppedAsLate: 0 }

function startClient(args: {
  id: number
  candidates: GitHubPRRefreshCandidate[]
  rpc: (req: RpcRequest) => Promise<Reply>
  factory: SchedulerFactory
  capable: boolean
  checks: boolean
}): { stop: () => void; setSelectedOnly: (v: boolean) => void; setVisible: (v: boolean) => void; foreground: () => void } {
  const scheduler = args.factory()
  const cache = new Map<string, { fetchedAt: number; outcome: PRRefreshOutcome }>()
  // D2-1: hints are bound to an epoch and to the data they were issued against.
  const hints = createHintStore()
  let selectedOnly = false
  let stopped = false
  const apply = (c: GitHubPRRefreshCandidate, reply: Reply, startedInEpoch: string): boolean => {
    if (reply.kind === 'upstream-error') return false
    if (reply.kind !== 'deferred') {
      const before = cache.get(c.cacheKey)?.fetchedAt
      // Same rule as setGitHubPRResultCaches: an outcome that is not newer is a no-op.
      if (before === undefined || reply.fetchedAt > before) {
        cache.set(c.cacheKey, { fetchedAt: reply.fetchedAt, outcome: reply })
        if (c.linkedPRNumber != null) noteObservation(`c${args.id}`, c.linkedPRNumber, reply)
      }
    }
    if (args.capable && reply.nextRefreshAt !== undefined) {
      const kept = hints.note(c.cacheKey, reply.nextRefreshAt, startedInEpoch, cache.get(c.cacheKey)?.fetchedAt ?? null)
      if (!kept) clientStats.hintsDroppedAsLate += 1
    }
    return true
  }
  const targets = () =>
    args.candidates
      .filter((c) => !selectedOnly || c.isSelected === true)
      .map((c) => {
        const entry = cache.get(c.cacheKey)
        const pr = entry?.outcome.kind === 'found' ? entry.outcome.pr : null
        const selected = c.isSelected === true
        const hint = args.capable ? hints.get(c.cacheKey, entry?.fetchedAt ?? null) : undefined
        const intervalMs = args.capable
          ? hint === null
            ? null
            : d2.localInterval(entry?.outcome as never, selected)
          : reviewRefreshIntervalMs({
              state: pr?.state ?? null,
              checksStatus: pr?.checksStatus ?? null,
              hasReview: entry ? entry.outcome.kind === 'found' : null,
              selected
            })
        return {
          key: c.cacheKey,
          revision: c.currentHeadOid ?? '',
          fetchedAt: entry?.fetchedAt ?? null,
          intervalMs,
          ...(args.capable ? { nextRefreshAt: typeof hint === 'number' ? hint : null } : {}),
          selected,
          refresh: async () => {
            clientStats.refreshCalls += 1
            const before = cache.get(c.cacheKey)?.fetchedAt
            const epoch = hints.epoch(c.cacheKey)
            const reply = await args.rpc({
              c,
              clientId: args.id,
              capable: args.capable,
              ...(args.capable ? { selected } : {})
            })
            if (stopped) return true
            const accepted = apply(c, reply, epoch)
            const after = cache.get(c.cacheKey)?.fetchedAt
            // Old client: production predicate (fetchedAt must advance). New client: a host
            // answer that is not an error is a success.
            const ok = args.capable ? accepted : after !== undefined && (before === undefined || after > before)
            if (!ok) clientStats.failures += 1
            scheduler.update(targets() as never)
            return ok
          }
        }
      })
  scheduler.update(targets() as never)
  scheduler.setVisible(true)

  // MODELLED Checks panel: a timed read of the selected PR's checks, paced by the host hint.
  let checksTimer: ReturnType<typeof setTimeout> | undefined
  const checksTarget = args.candidates.find((c) => c.isSelected === true && c.linkedPRNumber != null)
  const checksTick = async (): Promise<void> => {
    if (stopped || !checksTarget) return
    clientStats.checksCalls += 1
    const reply = await args.rpc({ c: checksTarget, clientId: args.id, capable: true, selected: true, checks: true })
    if (stopped) return
    const next = reply.kind === 'upstream-error' ? Date.now() + 60_000 : (reply.nextRefreshAt ?? null)
    if (next !== null) checksTimer = setTimeout(checksTick, Math.max(REVIEW_REFRESH_COOLDOWN_MS, next - Date.now()))
  }
  if (args.checks && args.capable) void checksTick()

  const foreground = (): void => {
    for (const c of args.candidates.filter((x) => x.isSelected === true)) {
      clientStats.foregroundCalls += 1
      const epoch = hints.epoch(c.cacheKey)
      void args.rpc({ c, clientId: args.id, capable: args.capable, selected: true, foreground: true }).then((r) => {
        if (stopped) return
        apply(c, r, epoch)
        scheduler.update(targets() as never)
      })
    }
  }
  const fgTimer = cfg.fgEveryS > 0 ? setInterval(foreground, cfg.fgEveryS * 1000) : undefined
  return {
    // A client that goes away says nothing to the host: no cancel RPC exists.
    stop: () => {
      stopped = true
      clearTimeout(checksTimer)
      clearInterval(fgTimer)
      scheduler.dispose()
    },
    setSelectedOnly: (v) => {
      selectedOnly = v
      // Pause enter/leave retires every hint; a reply already in flight cannot reinstall one.
      hints.invalidateAll()
      scheduler.update(targets() as never)
    },
    setVisible: (v) => scheduler.setVisible(v),
    foreground
  }
}

function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

it(
  `d3 ${cfg.scenario} gate=${cfg.gate} host=${cfg.host} N=${cfg.n} clients=${cfg.clients} ${cfg.workload} ${cfg.focus} ${cfg.hours}h`,
  async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date('2026-11-11T10:00:07Z'))
    rec.t0 = Date.now()
    d2.focus.blurredAt = Date.now()
    const candidates = seedWorld()
    scheduleEvents(candidates)
    const stops: (() => void)[] = []
    let host: ReturnType<typeof createHostAfter> | null = null
    const desktop = cfg.scenario.startsWith('desktop')

    if (desktop) {
      addPRRefreshOutcomeObserver((candidate, outcome) => {
        if (candidate.linkedPRNumber != null) noteObservation('host', candidate.linkedPRNumber, outcome)
      })
      let generation = 0
      const report = (visible: boolean): void => {
        for (let w = 1; w <= cfg.clients; w++) {
          reportVisiblePRRefreshCandidates(
            visible ? candidates.map((c) => ({ ...c, isSelected: w === 1 && c.isSelected })) : [],
            ++generation + Date.now(),
            w
          )
        }
      }
      d2.focus.focused = cfg.focus === 'focused'
      report(cfg.focus !== 'hidden')
      if (cfg.scenario === 'desktop-after' && cfg.idle === 'pause' && cfg.focus !== 'focused') {
        // Idle starts IDLE_AFTER_MS after blur: one re-report retimes queued follow-ups.
        setTimeout(() => report(cfg.focus !== 'hidden'), IDLE_AFTER_MS + 1)
      }
      if (cfg.focus === 'return') {
        // Blurred from t=0, focus returns at 30 min: measure how fast every row is fresh again.
        setTimeout(() => {
          d2.focus.focused = true
          report(true)
        }, 30 * 60_000)
      }
    } else {
      const after = cfg.scenario !== 'serve-before'
      const capable = cfg.scenario === 'serve-after'
      host = after ? createHostAfter() : null
      const rpc = async (req: RpcRequest): Promise<Reply> => {
        if (host) return host.rpc(req)
        // Before: no host store and no gate. Every client read is an upstream read.
        const started = Date.now()
        const outcome = await upstreamRead(req.c)
        rpcStats.rpcMs.push(Date.now() - started)
        rpcStats.maxRpcMs = Math.max(rpcStats.maxRpcMs, Date.now() - started)
        rpcStats.upstreamStarts.push(started - rec.t0)
        if (req.c.linkedPRNumber != null) noteObservation('host', req.c.linkedPRNumber, outcome)
        return outcome
      }
      const factory: SchedulerFactory = capable ? await schedulerFactory('d3') : createVisibleHostedReviewRefreshScheduler
      // EXP_SELECTED_IDS > 1: client k selects the k-th PR with running CI (mixed workload),
      // so there are that many distinct selected read identities. Otherwise everyone selects row 0.
      const runningRows = candidates.map((c, i) => (c.linkedPRNumber != null && i % 5 === 2 ? i : -1)).filter((i) => i >= 0)
      const selectedIndex = (k: number): number =>
        cfg.selectedIds > 1 || cfg.selectedRunning ? (runningRows[(k - 1) % Math.min(cfg.selectedIds, runningRows.length)] ?? 0) : 0
      for (let k = 1; k <= cfg.clients; k++) {
        const own =
          cfg.disjoint && k === cfg.clients
            ? Array.from({ length: 5 }, (_, i) => {
                const number = 900 + i
                const branch = `feat/other-${i}`
                const head = (900 + i).toString(16).padStart(40, 'c')
                rec.prs.set(number, { head, branch, state: 'OPEN', checks: 'done' })
                rec.branchToPR.set(branch, number)
                return {
                  cacheKey: `/fx/wt-${900 + i}::${branch}`,
                  repoKind: 'git' as const,
                  repoId: 'fixture-repo',
                  repoPath: `/fx/wt-${900 + i}`,
                  branch,
                  worktreeId: `wt-${900 + i}`,
                  currentHeadOid: head,
                  linkedPRNumber: number,
                  isSelected: i === 0,
                  cachedFetchedAt: null
                }
              })
            : candidates.map((c, i) => ({ ...c, isSelected: i === selectedIndex(k) }))
        setTimeout(() => {
          const client = startClient({ id: k, candidates: own, rpc, factory, capable, checks: cfg.checks && after })
          stops.push(client.stop)
          if (cfg.focus === 'hidden') client.setVisible(false)
          if (cfg.focus === 'unfocused' && after) setTimeout(() => client.setSelectedOnly(true), IDLE_AFTER_MS)
          if (cfg.disconnectMin !== null && k === 1) setTimeout(client.stop, cfg.disconnectMin * 60_000 - (k - 1) * cfg.staggerS * 1000)
          if (cfg.allGoneMin !== null) setTimeout(client.stop, cfg.allGoneMin * 60_000 - (k - 1) * cfg.staggerS * 1000)
        }, (k - 1) * cfg.staggerS * 1000)
      }
    }

    for (let s = 0; s < SECONDS; s++) {
      await vi.advanceTimersByTimeAsync(1000)
    }
    for (const stop of stops) stop()

    const ghTimes = rec.gh.map((g) => g.t)
    const byKind: Record<string, number> = {}
    const byHost: Record<string, number> = {}
    for (const g of rec.gh) {
      byKind[g.kind] = (byKind[g.kind] ?? 0) + 1
      byHost[g.host] = (byHost[g.host] ?? 0) + 1
    }
    const minutes = Math.ceil(SECONDS / 60)
    const timeline = Array.from({ length: minutes }, (_, m) => rec.gh.filter((g) => g.t >= m * 60_000 && g.t < (m + 1) * 60_000).length)
    const steadyFrom = 15 * 60_000
    const steady = ghTimes.filter((t) => t >= steadyFrom)
    const steadyMinutes = Math.max(1, (SECONDS * 1000 - steadyFrom) / 60_000)
    const worst15 = (() => {
      let worst = 0
      for (let m = 15; m + 15 <= minutes; m++) {
        const mean = timeline.slice(m, m + 15).reduce((a, b) => a + b, 0) / 15
        const peak = Math.max(...timeline.slice(m, m + 15))
        if (mean > 0) worst = Math.max(worst, peak / mean)
      }
      return +worst.toFixed(2)
    })()
    const lat = (filter: (d: Detection) => boolean, who: 'host' | 'client'): number[] =>
      detections
        .filter(filter)
        .flatMap((d) => (who === 'host' ? (d.host === undefined ? [] : [d.host]) : Object.values(d.clients)))
        .map((ms) => Math.round(ms / 1000))
    const detectionSummary = (filter: (d: Detection) => boolean) => {
      const who = desktop ? 'host' : 'client'
      const values = lat(filter, who)
      return { samples: values.length, p50: pct(values, 50), p90: pct(values, 90), max: values.length ? Math.max(...values) : null }
    }
    const result = {
      config: cfg,
      simulatedSeconds: SECONDS,
      gh: {
        spawns: rec.gh.length,
        perHour: +(rec.gh.length / cfg.hours).toFixed(1),
        byKind,
        apiRequestsByHost: byHost,
        apiRequestsPerHourByHost: Object.fromEntries(Object.entries(byHost).map(([h, n]) => [h, +(n / cfg.hours).toFixed(1)])),
        firstHour: ghTimes.filter((t) => t < 3_600_000).length,
        perHourCounts: Array.from({ length: Math.ceil(cfg.hours) }, (_, h) => ghTimes.filter((t) => t >= h * 3_600_000 && t < (h + 1) * 3_600_000).length),
        lastHourByKind: (() => { const o: Record<string, number> = {}; const from = (Math.ceil(cfg.hours) - 1) * 3_600_000; for (const g of rec.gh) if (g.t >= from) o[g.kind] = (o[g.kind] ?? 0) + 1; return o })(),
        lastHourRollingPeak60s: rollingPeak(ghTimes.filter((t) => t >= (Math.ceil(cfg.hours) - 1) * 3_600_000), 60_000),
        first15min: ghTimes.filter((t) => t < steadyFrom).length,
        steadyPerHour: +((steady.length / steadyMinutes) * 60).toFixed(1),
        steadyPerMinute: +(steady.length / steadyMinutes).toFixed(2),
        rollingPeak60s: rollingPeak(ghTimes, 60_000),
        rollingPeak60sSteady: rollingPeak(steady, 60_000),
        worstPeakToMean15min: worst15,
        timelinePerMinute: timeline
      },
      git: { total: rec.git.length },
      serve: desktop
        ? null
        : (() => {
            const pctS = (v: number[], p: number): number => Math.round((pct(v, p) ?? 0) / 1000)
            const events = host?.gate.events ?? []
            const starts = events.filter((e) => e.kind === 'start')
            const admits: Record<string, number> = {}
            const waitedByClient: Record<string, number[]> = {}
            for (const e of starts) {
              admits[e.lane] = (admits[e.lane] ?? 0) + 1
              if (e.kind === 'start') (waitedByClient[e.client] ??= []).push(e.waitedMs)
            }
            // Service of each selected read identity: how far apart its upstream starts were.
            const selectedKeys = new Set(starts.filter((e) => e.lane === 'selected-own' || e.lane === 'selected-borrowed').map((e) => e.key))
            const selectedIdentities = [...selectedKeys].map((key) => {
              const ts = starts.filter((e) => e.key === key).map((e) => e.t - rec.t0)
              const gaps = ts.slice(1).map((t, i) => t - ts[i])
              const parsed = JSON.parse(key) as unknown[]
              return { identity: `${parsed[0]}:${parsed[2]}`, starts: ts.length, medianGapS: pctS(gaps, 50), maxGapS: Math.round(Math.max(0, ...gaps) / 1000) }
            })
            const goneAt = cfg.allGoneMin === null ? null : cfg.allGoneMin * 60_000 + 60_000
            return {
              gate: host ? cfg.gate : 'none',
              upstreamStarts: rpcStats.upstreamStarts.length,
              maxStartsPer5min: rollingPeak(rpcStats.upstreamStarts, 5 * 60_000),
              maxStartsPer60s: rollingPeak(rpcStats.upstreamStarts, 60_000),
              admits,
              lanes: host ? summarizeGate(host.gate, rec.t0, Date.now()) : null,
              selectedIdentities,
              cacheHits: rpcStats.hits,
              lastGoodServedOverBudget: rpcStats.staleServed,
              deferredCold: rpcStats.deferredCold,
              replyDeadlineHits: rpcStats.replyDeadlineHits,
              interactiveOverflow: rpcStats.interactiveOverflow,
              legacy: { hits: rpcStats.legacyHits, upstreamReads: rpcStats.legacyReads },
              maxRpcSimulatedMs: rpcStats.maxRpcMs,
              rpcSimulatedMs: { p50: pct(rpcStats.rpcMs, 50), p99: pct(rpcStats.rpcMs, 99), over10s: rpcStats.rpcMs.filter((ms) => ms > REPLY_DEADLINE_MS + 50).length },
              queueAgeSecondsByClient: Object.fromEntries(
                Object.entries(waitedByClient).map(([k, v]) => [k, { admits: v.length, p50: pctS(v, 50), max: Math.round(Math.max(0, ...v) / 1000) }])
              ),
              clientRefreshCalls: clientStats.refreshCalls,
              clientFailures: clientStats.failures,
              checksCalls: clientStats.checksCalls,
              foregroundCalls: clientStats.foregroundCalls,
              hintsDroppedAsLate: clientStats.hintsDroppedAsLate,
              upstreamStartsAfterAllClientsGone: goneAt === null ? null : rpcStats.upstreamStarts.filter((t) => t >= goneAt).length
            }
          })(),
      detection: cfg.events
        ? {
            events: detections.length,
            startSelected: detectionSummary((d) => d.kind === 'start' && d.selected),
            startVisible: detectionSummary((d) => d.kind === 'start' && !d.selected),
            finishSelected: detectionSummary((d) => d.kind === 'finish' && d.selected),
            finishVisible: detectionSummary((d) => d.kind === 'finish' && !d.selected),
            undetected: detections.filter((d) => (desktop ? d.host === undefined : Object.keys(d.clients).length < cfg.clients) && d.at < SECONDS * 1000 - 20 * 60_000).length
          }
        : null,
      focusReturn:
        cfg.focus === 'return'
          ? (() => {
              const T = 30 * 60_000
              const afterReturn = ghTimes.filter((t) => t >= T)
              let last = T
              for (const t of afterReturn) {
                if (t - last > 30_000) break
                last = t
              }
              return {
                spawnsBeforeReturn: ghTimes.filter((t) => t < T).length,
                spawnsFirst15minAfter: afterReturn.filter((t) => t < T + 15 * 60_000).length,
                catchUpBurstSeconds: Math.round((last - T) / 1000)
              }
            })()
          : null,
      unknownGit: [...rec.unknownGit],
      unknownGh: [...rec.unknownGh]
    }
    mkdirSync(path.dirname(OUT), { recursive: true })
    writeFileSync(OUT, JSON.stringify(result, null, 2))
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ...result, gh: { ...result.gh, timelinePerMinute: undefined } }))
    vi.useRealTimers()
  },
  3_000_000
)

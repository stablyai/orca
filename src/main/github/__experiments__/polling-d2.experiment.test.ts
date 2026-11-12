/**
 * DISPOSABLE EXPERIMENT (STA-8667 design rounds D2/D3). Lives only on the harness branch
 * AmethystLiang/sta-8667-polling-harness; never merge. See RUN.md.
 *
 * Simulated time (vitest fake timers). Real production code under test:
 *   - desktop: coordinator, queue, drainer, pacing, visibility, rate-limit gate, lookup pipeline.
 *   - serve:   runHostedPRRead + getPRForBranchOutcome, real renderer scheduler module.
 * Replaced: the `gh` and `git` subprocess boundaries (recorders with canned answers).
 *
 * "after" scenarios prototype the D2 proposal without touching production files:
 *   - B (host backoff map, completion-based running predicate, rich signature) via a partial
 *     mock of pr-refresh-candidate-policy (desktop) and a host paced store (serve).
 *   - C (non-blocking admission gate on host cache misses) in `hostRpcAfter`.
 *   - D (header-fed rate-limit snapshot: probe only when cold or after reset) via a wrapper
 *     around getRateLimit.
 *   - idle "active-only" (no focused window for IDLE_AFTER_MS pauses non-selected rows).
 *   - client contract: real scheduler source plus one patch (honour target.nextRefreshAt).
 *
 * Env: EXP_SCENARIO desktop-before|desktop-after|serve-before|serve-after|serve-after-oldclient
 *      EXP_HOST ghes|dotcom, EXP_N, EXP_CLIENTS, EXP_HOURS, EXP_WORKLOAD settled|mixed,
 *      EXP_FOCUS focused|unfocused|hidden|return, EXP_IDLE pause|none, EXP_JITTER (0..0.2),
 *      EXP_EVENTS 0|1 (external CI start/finish events for the detection sweep),
 *      EXP_STAGGER_S, EXP_DISJOINT (serve: last client sees 5 rows nobody else sees), EXP_OUT
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  cadence: (process.env.EXP_CADENCE ?? 'default') as 'default' | 'reduced' | 'minimal' | 'off',
  focus: process.env.EXP_FOCUS ?? 'focused',
  idle: process.env.EXP_IDLE ?? 'pause',
  jitter: Number(process.env.EXP_JITTER ?? 0),
  events: process.env.EXP_EVENTS === '1',
  staggerS: Number(process.env.EXP_STAGGER_S ?? 25),
  disjoint: process.env.EXP_DISJOINT === '1',
  seed: Number(process.env.EXP_SEED ?? 1),
  eventTargets: Number(process.env.EXP_EVENT_TARGETS ?? 7)
}))

const IDLE_AFTER_MS = 5 * 60_000

type PRWorld = {
  head: string
  state: 'OPEN' | 'MERGED'
  branch: string
  // per-check state; "running" keeps `build` in progress, "failed-running" adds a failed check.
  checks: 'done' | 'running' | 'failed-running'
}

const rec = vi.hoisted(() => {
  return {
    gh: [] as { t: number; kind: string; host: string }[],
    git: [] as { t: number; argv: string[] }[],
    unknownGit: new Set<string>(),
    unknownGh: new Set<string>(),
    prs: new Map<number, PRWorld>(),
    branchToPR: new Map<string, number>(),
    t0: 0
  }
})

/** D2 policy prototype shared by the desktop mock and the serve host. */
const d2 = vi.hoisted(() => {
  type Meta = {
    signature: string
    unchanged: number
    runningSince: number | null
    unknownMergeSince: number | null
    hasPR: boolean
    state: string | null
    running: boolean
    unknownMerge: boolean
  }
  const backoff = new Map<string, Meta>()
  const focus = { focused: true, blurredAt: 0 as number, visible: true }

  function hash(text: string): number {
    let h = 2166136261
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return (h >>> 0) / 0xffffffff
  }

  function describe(outcome: {
    kind: string
    pr?: Record<string, unknown>
  }): Omit<Meta, 'unchanged' | 'runningSince' | 'unknownMergeSince'> {
    if (outcome.kind !== 'found' || !outcome.pr) {
      return {
        signature: outcome.kind,
        hasPR: false,
        state: null,
        running: false,
        unknownMerge: false
      }
    }
    const p = outcome.pr as {
      number: number
      state: string
      headSha?: string
      checksStatus?: string
      checksSummary?: { pending?: number; passed?: number; failed?: number; total?: number }
      checksFinal?: boolean
      checksReadComplete?: boolean
      failingCheckNames?: string[]
      mergeable?: string
      mergeStateStatus?: string | null
      reviewDecision?: string | null
      updatedAt?: string
    }
    const open = p.state === 'open' || p.state === 'draft'
    // Completion decides "running", never the failure-first aggregate status (D1-A3).
    const running =
      (open || p.state === 'merged') &&
      (p.checksFinal === false ||
        (p.checksSummary?.pending ?? 0) > 0 ||
        p.checksReadComplete === false)
    const unknownMerge =
      open &&
      p.mergeable === 'UNKNOWN' &&
      !['CLEAN', 'BEHIND', 'BLOCKED'].includes(p.mergeStateStatus ?? '')
    return {
      signature: JSON.stringify([
        p.number,
        p.state,
        p.headSha,
        p.checksStatus,
        p.checksSummary ?? null,
        p.checksFinal ?? null,
        p.checksReadComplete ?? null,
        [...(p.failingCheckNames ?? [])].sort(),
        p.mergeable,
        p.mergeStateStatus ?? null,
        p.reviewDecision ?? null,
        p.updatedAt
      ]),
      hasPR: true,
      state: p.state,
      running,
      unknownMerge
    }
  }

  function note(key: string, outcome: { kind: string; pr?: Record<string, unknown> }): Meta {
    const d = describe(outcome)
    const prev = backoff.get(key)
    const same = prev !== undefined && prev.signature === d.signature
    const now = Date.now()
    const meta: Meta = {
      ...d,
      unchanged: same ? prev.unchanged + 1 : 0,
      runningSince: d.running ? (same ? (prev.runningSince ?? now) : now) : null,
      unknownMergeSince: d.unknownMerge ? (prev?.unknownMergeSince ?? now) : null
    }
    backoff.set(key, meta)
    return meta
  }

  /** Interval before the next timed upstream read. Jitter only shortens, so caps stay caps. */
  function interval(key: string, selected: boolean, anchor: number, jitter: number): number {
    const raw = intervalAtDefault(key, selected, anchor, jitter)
    if (cfg.cadence === 'off') {
      return Number.POSITIVE_INFINITY
    }
    return raw
  }

  // Cadence composition: every base is multiplied by the cadence factor F; a backoff cap is
  // min(defaultCap * F, ceiling) and never below the cadence's own base.
  const F = { default: 1, reduced: 5, minimal: 10, off: 1 }[cfg.cadence]
  const CEIL_SELECTED = 30 * 60_000
  const CEIL_VISIBLE = 60 * 60_000

  function intervalAtDefault(key: string, selected: boolean, anchor: number, jitter: number): number {
    const m = backoff.get(key)
    const j = (ms: number): number =>
      jitter > 0 ? Math.round(ms * (1 - jitter * hash(`${key}|${anchor}`))) : ms
    if (!m) {
      return (selected ? 60_000 : 120_000) * F
    }
    const now = Date.now()
    const double = (base: number, cap: number): number => {
      const ceiling = selected ? CEIL_SELECTED : CEIL_VISIBLE
      return Math.max(base * F, Math.min(cap * F, ceiling, base * F * 2 ** Math.min(m.unchanged, 6)))
    }
    if (!m.hasPR) {
      return j(selected ? double(60_000, 5 * 60_000) : 15 * 60_000 * F)
    }
    if (m.state === 'merged') {
      return m.running ? 60_000 * F : Number.POSITIVE_INFINITY
    }
    if (m.state === 'closed') {
      return j(15 * 60_000 * F)
    }
    const unknownHolds = m.unknownMergeSince !== null && now - m.unknownMergeSince < 10 * 60_000
    if (m.running || unknownHolds) {
      if (selected) {
        return 60_000 * F
      }
      // Non-selected: a per-check picture frozen for 30 min is a stuck check; let it decay.
      const frozenFor = m.runningSince === null ? 0 : now - m.runningSince
      if (!m.running || frozenFor < 30 * 60_000) {
        return 120_000 * F
      }
      const steps = Math.floor((frozenFor - 30 * 60_000) / (10 * 60_000)) + 1
      return j(Math.max(120_000 * F, Math.min(15 * 60_000 * F, CEIL_VISIBLE, 120_000 * F * 2 ** Math.min(steps, 3))))
    }
    return j(selected ? double(60_000, 5 * 60_000) : double(120_000, 15 * 60_000))
  }

  function idle(): boolean {
    return !focus.focused && Date.now() - focus.blurredAt >= 5 * 60_000
  }

  return { backoff, focus, note, interval, idle, describe }
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
            nodes: [{ databaseId: 11, conclusion: pr.checks === 'done' ? 'SUCCESS' : null }],
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
  await new Promise((r) => setTimeout(r, 400)) // one gh call takes ~0.4 s of simulated time
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

// #40541's setting, modelled the way its scaleReviewRefreshInterval works: every timed interval
// is multiplied by the cadence factor; Off has no timed interval.
vi.mock('../../../shared/review-refresh-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/review-refresh-policy')>()
  const factor = { default: 1, reduced: 5, minimal: 10, off: 1 }[cfg.cadence]
  return {
    ...actual,
    reviewRefreshIntervalMs: (input: Parameters<typeof actual.reviewRefreshIntervalMs>[0]) => {
      const base = actual.reviewRefreshIntervalMs(input)
      return base === null || cfg.cadence === 'off' ? null : base * factor
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
import { reviewRefreshIntervalMs } from '../../../shared/review-refresh-policy'
import { createVisibleHostedReviewRefreshScheduler } from '../../../renderer/src/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler'

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
        checks: cfg.workload === 'mixed' && linked && i % 5 === 2 ? (i % 10 === 2 ? 'failed-running' : 'running') : 'done'
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
type Reply = (PRRefreshOutcome & { nextRefreshAt?: number }) | Deferred
type RpcRequest = {
  c: GitHubPRRefreshCandidate
  clientId: number
  selected?: boolean
  foreground?: boolean
  capable: boolean
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

const gateStats = {
  admits: { interactive: 0, selected: 0, visible: 0, coldOldClient: 0 },
  hits: 0,
  staleServed: 0,
  deferredCold: 0,
  upstreamStarts: [] as number[],
  queueAgeMsByClient: {} as Record<string, number[]>,
  maxRpcMs: 0
}

/** C: non-blocking admission gate. No queue and no stored demand: a refused caller gets a hint
 *  and comes back; a claim only remembers who was refused first, and it expires. */
function createGate() {
  const WINDOW = 5 * 60_000
  const MAX = 20
  const SPACING = 10_000
  const SELECTED_RESERVE = 4
  const GRACE = 15_000
  const starts: number[] = []
  let lastVisibleStart = -Infinity
  // One claim per refused identity (not per client): who is most overdue, and when its caller
  // was told to come back. It holds no request and expires on its own.
  const claims = new Map<string, { dueSince: number; first: number; retryAt: number; until: number }>()
  const prune = (now: number): void => {
    while (starts.length > 0 && now - starts[0] >= WINDOW) starts.shift()
    for (const [k, v] of claims) if (v.until < now) claims.delete(k)
  }
  return (
    clientId: number,
    key: string,
    lane: 'interactive' | 'selected' | 'visible',
    dueSince: number,
    honoursHints: boolean
  ) => {
    const now = Date.now()
    prune(now)
    const admit = () => {
      const claim = claims.get(key)
      ;(gateStats.queueAgeMsByClient[clientId] ??= []).push(claim ? now - claim.first : 0)
      claims.delete(key)
      if (lane !== 'interactive') starts.push(now)
      if (lane === 'visible') lastVisibleStart = now
      gateStats.admits[lane] += 1
      return { admit: true as const }
    }
    if (lane === 'interactive') return admit()
    const windowFreeAt = starts.length >= MAX ? starts[0] + WINDOW : now
    if (lane === 'selected') {
      return windowFreeAt > now ? { admit: false as const, retryAt: windowFreeAt } : admit()
    }
    const visibleMax = MAX - SELECTED_RESERVE
    const visibleWindowFreeAt = starts.length >= visibleMax ? starts[starts.length - visibleMax] + WINDOW : now
    const freeAt = Math.max(now, visibleWindowFreeAt, lastVisibleStart + SPACING)
    const mine = claims.get(key)?.dueSince ?? dueSince
    let ahead = 0
    let aheadHere = 0
    for (const [k, v] of claims) {
      if (k === key || v.dueSince > mine || (v.dueSince === mine && k > key)) continue
      ahead += 1
      // Only a claimant that was told to be back by now can make this caller wait.
      if (v.retryAt <= now) aheadHere += 1
    }
    if (freeAt <= now && aheadHere === 0) return admit()
    const retryAt = Math.max(now + SPACING, freeAt + ahead * SPACING)
    const existing = claims.get(key)
    claims.set(key, {
      dueSince: mine,
      first: existing?.first ?? now,
      // A legacy client ignores the hint; its claim only records how overdue the row is.
      retryAt: honoursHints ? retryAt : Number.POSITIVE_INFINITY,
      until: honoursHints ? retryAt + GRACE : now + 16 * 60_000
    })
    return { admit: false as const, retryAt }
  }
}

function createHostAfter() {
  const gate = createGate()
  // Full read identity as the key; every slot is independent (no single-slot eviction).
  const store = new Map<string, { outcome: PRRefreshOutcome; fetchedAt: number }>()
  const inFlight = new Map<string, Promise<PRRefreshOutcome>>()
  return async (req: RpcRequest): Promise<Reply> => {
    const started = Date.now()
    const done = <T,>(reply: T): T => {
      gateStats.maxRpcMs = Math.max(gateStats.maxRpcMs, Date.now() - started)
      return reply
    }
    const { c } = req
    const key = JSON.stringify([c.repoPath, c.branch, c.linkedPRNumber ?? null, c.fallbackPRNumber ?? null, false, c.currentHeadOid ?? null])
    const selected = req.selected === true
    const entry = store.get(key)
    const timed = req.foreground !== true
    if (timed && entry && !req.capable) {
      // Legacy client (no `selected` field): #40541's reuse window only, never longer than the
      // client's own interval, so its fetchedAt-must-advance rule keeps seeing new answers.
      const pr = entry.outcome.kind === 'found' ? entry.outcome.pr : null
      const ttl = reviewRefreshIntervalMs({ state: pr?.state ?? null, checksStatus: pr?.checksStatus ?? null, hasReview: pr !== null, selected: true })
      if (ttl === null || Date.now() - entry.fetchedAt < ttl) {
        gateStats.hits += 1
        return done(entry.outcome)
      }
    } else if (timed && entry) {
      const nextAt = entry.fetchedAt + d2.interval(key, selected, entry.fetchedAt, cfg.jitter)
      if (Date.now() < nextAt) {
        gateStats.hits += 1
        return done({ ...entry.outcome, nextRefreshAt: nextAt })
      }
    }
    let read = inFlight.get(key)
    if (!read) {
      const dueSince = entry ? entry.fetchedAt + d2.interval(key, selected, entry.fetchedAt, cfg.jitter) : started
      const admission = gate(req.clientId, key, timed ? (selected ? 'selected' : 'visible') : 'interactive', dueSince, req.capable)
      if (!admission.admit) {
        if (entry) {
          gateStats.staleServed += 1
          return done(req.capable ? { ...entry.outcome, nextRefreshAt: admission.retryAt } : entry.outcome)
        }
        if (req.capable) {
          gateStats.deferredCold += 1
          return done({ kind: 'deferred', nextRefreshAt: admission.retryAt })
        }
        // An old client cannot parse `deferred`; its cold miss reads once, outside the budget.
        gateStats.admits.coldOldClient += 1
      }
      gateStats.upstreamStarts.push(Date.now() - rec.t0)
      read = upstreamRead(c).then((outcome) => {
        inFlight.delete(key)
        if (outcome.kind !== 'upstream-error') {
          const existing = store.get(key)
          if (!existing || existing.fetchedAt <= outcome.fetchedAt) {
            d2.note(key, outcome as never)
            store.set(key, { outcome, fetchedAt: outcome.fetchedAt })
          }
          if (c.linkedPRNumber != null) noteObservation('host', c.linkedPRNumber, outcome)
        }
        return outcome
      })
      inFlight.set(key, read)
    }
    const outcome = await read
    if (outcome.kind === 'upstream-error' || !req.capable) return done(outcome)
    return done({ ...outcome, nextRefreshAt: outcome.fetchedAt + d2.interval(key, selected, outcome.fetchedAt, cfg.jitter) })
  }
}

// ---------- serve: clients ----------
const clientStats = { refreshCalls: 0, failures: 0 }

type SchedulerFactory = typeof createVisibleHostedReviewRefreshScheduler

/** The real scheduler source with the single D2 change: a host `nextRefreshAt` replaces the
 *  client's own interval as the next timed attempt. Written next to this file and imported. */
async function patchedSchedulerFactory(): Promise<SchedulerFactory> {
  const src = path.resolve(
    __dirname,
    '../../../renderer/src/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler.ts'
  )
  let text = readFileSync(src, 'utf8')
  const a = "  selected: boolean\n  refresh:"
  const b = '    if (entry.target.intervalMs === null) {\n      return Infinity\n    }\n    const anchor'
  if (!text.includes(a) || !text.includes(b)) throw new Error('scheduler patch anchors moved')
  text = text
    .replace(a, '  selected: boolean\n  nextRefreshAt?: number | null\n  refresh:')
    .replace(
      b,
      '    if (entry.target.nextRefreshAt != null && entry.target.nextRefreshAt > entry.lastAttemptAt) {\n      return Math.max(cooldown, entry.target.nextRefreshAt)\n    }\n' + b
    )
    .replace("'../../../../../../shared/review-refresh-policy'", "'../../../../shared/review-refresh-policy'")
  const out = path.resolve(__dirname, '.generated/scheduler-d2.ts')
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, text)
  return (await import(/* @vite-ignore */ out)).createVisibleHostedReviewRefreshScheduler
}

function startClient(args: {
  id: number
  candidates: GitHubPRRefreshCandidate[]
  rpc: (req: RpcRequest) => Promise<Reply>
  factory: SchedulerFactory
  capable: boolean
}): { stop: () => void; setSelectedOnly: (v: boolean) => void; setVisible: (v: boolean) => void; foreground: () => void } {
  const scheduler = args.factory()
  const cache = new Map<string, { fetchedAt: number; outcome: PRRefreshOutcome }>()
  const hint = new Map<string, number>()
  let selectedOnly = false
  const apply = (c: GitHubPRRefreshCandidate, reply: Reply): boolean => {
    if (reply.kind === 'upstream-error') return false
    if (reply.nextRefreshAt !== undefined) hint.set(c.cacheKey, reply.nextRefreshAt)
    if (reply.kind === 'deferred') return true
    const before = cache.get(c.cacheKey)?.fetchedAt
    // Same rule as setGitHubPRResultCaches: an outcome that is not newer is a no-op.
    if (before === undefined || reply.fetchedAt > before) {
      cache.set(c.cacheKey, { fetchedAt: reply.fetchedAt, outcome: reply })
      if (c.linkedPRNumber != null) noteObservation(`c${args.id}`, c.linkedPRNumber, reply)
    }
    return true
  }
  const targets = () =>
    args.candidates
      .filter((c) => !selectedOnly || c.isSelected === true)
      .map((c) => {
        const entry = cache.get(c.cacheKey)
        const pr = entry?.outcome.kind === 'found' ? entry.outcome.pr : null
        return {
          key: c.cacheKey,
          revision: c.currentHeadOid ?? '',
          fetchedAt: entry?.fetchedAt ?? null,
          intervalMs: reviewRefreshIntervalMs({
            state: pr?.state ?? null,
            checksStatus: pr?.checksStatus ?? null,
            hasReview: entry ? entry.outcome.kind === 'found' : null,
            selected: c.isSelected === true
          }),
          ...(args.capable ? { nextRefreshAt: hint.get(c.cacheKey) ?? null } : {}),
          selected: c.isSelected === true,
          refresh: async () => {
            clientStats.refreshCalls += 1
            const before = cache.get(c.cacheKey)?.fetchedAt
            const reply = await args.rpc({
              c,
              clientId: args.id,
              capable: args.capable,
              ...(args.capable ? { selected: c.isSelected === true } : {})
            })
            const accepted = apply(c, reply)
            const after = cache.get(c.cacheKey)?.fetchedAt
            // Old client: production predicate (fetchedAt must advance). New client: a host
            // answer that is not an error is a success.
            const ok = args.capable ? accepted : after !== undefined && (before === undefined || after > before)
            if (!ok) clientStats.failures += 1
            scheduler.update(targets())
            return ok
          }
        }
      })
  scheduler.update(targets())
  scheduler.setVisible(true)
  return {
    stop: () => scheduler.dispose(),
    setSelectedOnly: (v) => {
      selectedOnly = v
      scheduler.update(targets())
    },
    setVisible: (v) => scheduler.setVisible(v),
    foreground: () => {
      for (const c of args.candidates.filter((x) => x.isSelected === true)) {
        void args.rpc({ c, clientId: args.id, capable: args.capable, selected: true, foreground: true }).then((r) => {
          apply(c, r)
          scheduler.update(targets())
        })
      }
    }
  }
}

function rollingPeak(times: number[], windowMs: number): number {
  let peak = 0
  let lo = 0
  for (let hi = 0; hi < times.length; hi++) {
    while (times[hi] - times[lo] >= windowMs) lo++
    peak = Math.max(peak, hi - lo + 1)
  }
  return peak
}

function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

it(
  `d2 ${cfg.scenario} cadence=${cfg.cadence} host=${cfg.host} N=${cfg.n} clients=${cfg.clients} ${cfg.workload} ${cfg.focus} ${cfg.hours}h`,
  async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date('2026-11-11T10:00:07Z'))
    rec.t0 = Date.now()
    d2.focus.blurredAt = Date.now()
    const candidates = seedWorld()
    scheduleEvents(candidates)
    const stops: (() => void)[] = []
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
      const host = after ? createHostAfter() : null
      // #40541's paced host cache (modelled from its diff): only when the cadence is not Default,
      // one slot per branch, reused until the selected interval for the cadence has passed.
      const paced40541 = new Map<string, PRRefreshOutcome>()
      const rpc = async (req: RpcRequest): Promise<Reply> => {
        if (host) return host(req)
        const slot = `${req.c.repoPath}::${req.c.branch}`
        const cachedOutcome = cfg.cadence === 'default' ? undefined : paced40541.get(slot)
        if (cachedOutcome) {
          const pr = cachedOutcome.kind === 'found' ? cachedOutcome.pr : null
          const ttl = reviewRefreshIntervalMs({ state: pr?.state ?? null, checksStatus: pr?.checksStatus ?? null, hasReview: pr !== null, selected: true })
          if (ttl === null || Date.now() - cachedOutcome.fetchedAt < ttl) {
            gateStats.hits += 1
            return cachedOutcome
          }
        }
        const started = Date.now()
        const outcome = await upstreamRead(req.c)
        gateStats.maxRpcMs = Math.max(gateStats.maxRpcMs, Date.now() - started)
        gateStats.upstreamStarts.push(started - rec.t0)
        if (req.c.linkedPRNumber != null) noteObservation('host', req.c.linkedPRNumber, outcome)
        if (outcome.kind !== 'upstream-error') paced40541.set(slot, outcome)
        return outcome
      }
      const factory = capable ? await patchedSchedulerFactory() : createVisibleHostedReviewRefreshScheduler
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
            : candidates
        setTimeout(() => {
          const client = startClient({ id: k, candidates: own, rpc, factory, capable })
          stops.push(client.stop)
          if (cfg.focus === 'hidden') client.setVisible(false)
          if (cfg.focus === 'unfocused' && after) setTimeout(() => client.setSelectedOnly(true), IDLE_AFTER_MS)
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
        : {
            upstreamStarts: gateStats.upstreamStarts.length,
            maxStartsPer5min: rollingPeak(gateStats.upstreamStarts, 5 * 60_000),
            admits: gateStats.admits,
            cacheHits: gateStats.hits,
            lastGoodServedOverBudget: gateStats.staleServed,
            deferredCold: gateStats.deferredCold,
            maxRpcSimulatedMs: gateStats.maxRpcMs,
            queueAgeSecondsByClient: Object.fromEntries(
              Object.entries(gateStats.queueAgeMsByClient).map(([k, v]) => [
                k,
                { admits: v.length, p50: Math.round((pct(v, 50) ?? 0) / 1000), max: Math.round(Math.max(0, ...v) / 1000) }
              ])
            ),
            clientRefreshCalls: clientStats.refreshCalls,
            clientFailures: clientStats.failures
          },
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

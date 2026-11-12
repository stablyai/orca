/**
 * DISPOSABLE EXPERIMENT (STA-8667 design stage). Not for commit.
 *
 * Measures background PR/checks polling cost on current main with the real coordinator, queue,
 * drainer, lookup pipeline and real git against fixture worktrees. Only the `gh` subprocess
 * boundary is replaced by a recorder that returns canned GitHub responses.
 *
 * Env:
 *   EXP_MODE      desktop | serve | serve-cached | serve-adaptive
 *   EXP_N         worktrees (default 10)
 *   EXP_CLIENTS   windows (desktop) or connected clients (serve) (default 1)
 *   EXP_SECONDS   wall-clock duration (default 300)
 *   EXP_OUT       output JSON path
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { it, vi } from 'vitest'
import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../shared/github/pull-request-refresh-types'
import { reviewRefreshIntervalMs } from '../../../shared/review-refresh-policy'

type Spawn = { t: number; argv: string[]; cwd?: string; kind: string }

const rec = vi.hoisted(() => {
  const state = {
    startedAt: 0,
    gh: [] as { t: number; argv: string[]; cwd?: string; kind: string }[],
    git: [] as { t: number; argv: string[]; cwd?: string }[],
    // Fixture world: PR number -> state
    prs: new Map<
      number,
      { head: string; state: 'OPEN' | 'MERGED'; checks: 'pending' | 'done'; branch: string }
    >(),
    branchToPR: new Map<string, number>(),
    etags: new Map<string, string>(),
    changedAt: null as number | null,
    detectedAt: new Map<number, number>()
  }
  return state
})

function ghKind(argv: string[]): string {
  const joined = argv.join(' ')
  if (argv[0] === 'api' && argv[1] === 'rate_limit') return 'api:rate_limit'
  if (argv[0] === 'api' && argv[1] === 'graphql') {
    if (joined.includes('stackEntry')) return 'graphql:sidebar'
    if (joined.includes('viewerDefaultMergeMethod')) return 'graphql:merge-metadata'
    if (joined.includes('commits(last: 1)')) return 'graphql:checks-page'
    return 'graphql:other'
  }
  if (argv[0] === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\?/.test(argv[1] ?? '')) return 'rest:pulls-by-head'
  if (argv[0] === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(argv[1] ?? '')) return 'rest:pull'
  if (argv[0] === 'api' && /commits/.test(argv[1] ?? '')) return 'rest:pr-commits'
  if (argv[0] === 'api') return `api:${argv[1]}`
  if (argv[0] === 'pr' && argv[1] === 'view') return 'pr:view'
  if (argv[0] === 'pr' && argv[1] === 'list') return 'pr:list'
  if (argv[0] === 'auth') return `auth:${argv[1]}`
  return `other:${argv[0]}`
}

function flag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length - 1; i++) {
    if ((argv[i] === '-f' || argv[i] === '-F' || argv[i] === '-H') && argv[i + 1].startsWith(`${name}=`)) {
      return argv[i + 1].slice(name.length + 1)
    }
    if (argv[i] === '-H' && argv[i + 1].toLowerCase().startsWith(`${name.toLowerCase()}:`)) {
      return argv[i + 1].slice(name.length + 1).trim()
    }
  }
  return undefined
}

function checksNodes(checks: 'pending' | 'done') {
  return [
    {
      __typename: 'CheckRun',
      name: 'build',
      databaseId: 1,
      status: checks === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: checks === 'pending' ? null : 'SUCCESS',
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
}

function commits(pr: { head: string; checks: 'pending' | 'done' }) {
  return {
    nodes: [
      {
        commit: {
          oid: pr.head,
          statusCheckRollup: {
            contexts: {
              nodes: checksNodes(pr.checks),
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          },
          checkSuites: {
            nodes: [{ databaseId: 11, conclusion: pr.checks === 'pending' ? null : 'SUCCESS' }],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }
    ]
  }
}

function sidebar(number: number) {
  const pr = rec.prs.get(number)
  if (!pr) {
    return JSON.stringify({
      data: { repository: { pullRequest: null } },
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'] }]
    })
  }
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          number,
          title: `PR ${number}`,
          state: pr.state,
          url: `https://github.com/acme/fixture/pull/${number}`,
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
          headRepository: { name: 'fixture' },
          commits: commits(pr),
          stack: null,
          stackEntry: null
        }
      }
    }
  })
}

function restPR(number: number) {
  const pr = rec.prs.get(number)!
  return {
    number,
    title: `PR ${number}`,
    state: pr.state === 'MERGED' ? 'closed' : 'open',
    html_url: `https://github.com/acme/fixture/pull/${number}`,
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

async function fakeGh(argv: string[], options: { cwd?: string } = {}) {
  const kind = ghKind(argv)
  rec.gh.push({ t: Date.now() - rec.startedAt, argv, cwd: options.cwd, kind })
  // Tiny async hop so coalescing windows behave like a real subprocess (not zero-latency).
  await new Promise((r) => setTimeout(r, 15))
  switch (kind) {
    case 'api:rate_limit':
      return {
        stdout: JSON.stringify({
          resources: {
            core: { limit: 5000, remaining: 4900, reset: Math.floor(Date.now() / 1000) + 3600 },
            graphql: { limit: 5000, remaining: 4900, reset: Math.floor(Date.now() / 1000) + 3600 },
            search: { limit: 30, remaining: 30, reset: Math.floor(Date.now() / 1000) + 60 }
          }
        }),
        stderr: ''
      }
    case 'graphql:sidebar': {
      const number = Number(flag(argv, 'number'))
      return { stdout: sidebar(number), stderr: '' }
    }
    case 'graphql:checks-page': {
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
      const state = url.searchParams.get('state')
      const number = rec.branchToPR.get(branch)
      const rows = number && rec.prs.has(number) ? [restPR(number)] : []
      const filtered = state === 'open' ? rows.filter((r) => r.state === 'open') : rows
      const body = JSON.stringify(filtered)
      const etag = `W/"${Buffer.from(body).toString('base64').slice(0, 16)}"`
      const ifNoneMatch = flag(argv, 'If-None-Match')
      if (ifNoneMatch && ifNoneMatch === etag) {
        const err = Object.assign(new Error('gh: HTTP 304'), {
          code: 1,
          stdout: httpResponse(304, '', etag),
          stderr: 'gh: HTTP 304'
        })
        throw err
      }
      return { stdout: httpResponse(200, body, etag), stderr: '' }
    }
    case 'rest:pull': {
      const number = Number(argv[1].split('/').pop())
      const body = JSON.stringify(restPR(number))
      const etag = `W/"${number}-${rec.prs.get(number)?.head.slice(0, 8)}"`
      const ifNoneMatch = flag(argv, 'If-None-Match')
      if (ifNoneMatch && ifNoneMatch === etag) {
        throw Object.assign(new Error('gh: HTTP 304'), {
          code: 1,
          stdout: httpResponse(304, '', etag),
          stderr: 'gh: HTTP 304'
        })
      }
      return { stdout: httpResponse(200, body, etag), stderr: '' }
    }
    case 'rest:pr-commits':
      return { stdout: '[]', stderr: '' }
    default:
      throw Object.assign(new Error(`unexpected gh call: ${argv.join(' ')}`), {
        code: 1,
        stderr: `unexpected gh call: ${argv.join(' ')}`
      })
  }
}

vi.mock('../../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: fakeGh,
  ghExecFileWithScopeAsync: async (argv: string[], options: { cwd?: string } = {}) => ({
    ...(await fakeGh(argv, options)),
    rateLimitScope: 'native::github.com'
  })
}))

vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git/command-runner/git-exec-file')>()
  return {
    ...actual,
    gitExecFileAsync: (args: string[], options: { cwd?: string }, ...rest: unknown[]) => {
      rec.git.push({ t: Date.now() - rec.startedAt, argv: args, cwd: options?.cwd })
      return (actual.gitExecFileAsync as Function)(args, options, ...rest)
    }
  }
})

vi.mock('../pr-refresh-renderer-port', () => ({
  prRefreshRenderers: () => ({ isRendererOpen: () => true, sendToTrustedUI: () => {} }),
  setPRRefreshRendererPort: () => {}
}))

import {
  enqueuePRRefresh,
  reportVisiblePRRefreshCandidates,
  runHostedPRRead
} from '../pr-refresh-coordinator'
import { getPRForBranchOutcome } from '../client/lookup/pr-for-branch-outcome'
import { createVisibleHostedReviewRefreshScheduler } from '../../../renderer/src/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler'

const MODE = process.env.EXP_MODE ?? 'desktop'
const N = Number(process.env.EXP_N ?? 10)
const CLIENTS = Number(process.env.EXP_CLIENTS ?? 1)
const SECONDS = Number(process.env.EXP_SECONDS ?? 300)
const STAGGER = Number(process.env.EXP_STAGGER_S ?? 0)
const CHANGE_AT = Number(process.env.EXP_CHANGE_AT_S ?? 0)
const OUT = process.env.EXP_OUT ?? `/tmp/polling-${MODE}-n${N}-c${CLIENTS}.json`
const FIXTURE_ROOT =
  process.env.EXP_FIXTURE_ROOT ?? path.join(path.dirname(OUT), `fixture-${MODE}-n${N}-c${CLIENTS}`)

function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function buildFixture(): { repoPath: string; worktrees: { path: string; branch: string; head: string }[] } {
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true, force: true })
  mkdirSync(FIXTURE_ROOT, { recursive: true })
  const repoPath = path.join(FIXTURE_ROOT, 'main')
  mkdirSync(repoPath)
  sh('git', ['init', '-q', '-b', 'main'], repoPath)
  sh('git', ['config', 'user.email', 'exp@example.com'], repoPath)
  sh('git', ['config', 'user.name', 'exp'], repoPath)
  sh('git', ['config', 'commit.gpgsign', 'false'], repoPath)
  writeFileSync(path.join(repoPath, 'README.md'), 'fixture\n')
  sh('git', ['add', '.'], repoPath)
  sh('git', ['commit', '-q', '-m', 'init'], repoPath)
  sh('git', ['remote', 'add', 'origin', 'https://github.com/acme/fixture.git'], repoPath)
  const worktrees: { path: string; branch: string; head: string }[] = []
  for (let i = 0; i < N; i++) {
    const branch = `feat/wt-${i}`
    const wt = path.join(FIXTURE_ROOT, `wt-${i}`)
    sh('git', ['worktree', 'add', '-q', '-b', branch, wt, 'main'], repoPath)
    writeFileSync(path.join(wt, `f${i}.txt`), `${i}\n`)
    sh('git', ['add', '.'], wt)
    sh('git', ['commit', '-q', '-m', `wt ${i}`], wt)
    const head = sh('git', ['rev-parse', 'HEAD'], wt).trim()
    worktrees.push({ path: wt, branch, head })
  }
  return { repoPath, worktrees }
}

type Fixture = ReturnType<typeof buildFixture>

/** 80% have a linked PR; of those 1 in 5 is merged and 1 in 5 has running CI. 20% branch-only, half of them with a PR discoverable by head. */
function seedWorld(fx: Fixture): GitHubPRRefreshCandidate[] {
  const candidates: GitHubPRRefreshCandidate[] = []
  fx.worktrees.forEach((wt, i) => {
    const number = 100 + i
    const linked = i % 5 !== 4
    const hasPR = linked || i % 10 === 4
    if (hasPR) {
      rec.prs.set(number, {
        head: wt.head,
        branch: wt.branch,
        state: linked && i % 5 === 3 ? 'MERGED' : 'OPEN',
        checks: linked && i % 5 === 2 ? 'pending' : 'done'
      })
      rec.branchToPR.set(wt.branch, number)
    }
    candidates.push({
      cacheKey: `${wt.path}::${wt.branch}`,
      repoKind: 'git',
      repoId: 'fixture-repo',
      repoPath: wt.path,
      branch: wt.branch,
      worktreeId: `wt-${i}`,
      currentHeadOid: wt.head,
      linkedPRNumber: linked ? number : null,
      isSelected: i === 0,
      cachedFetchedAt: null
    })
  })
  return candidates
}

function summarize(spawns: Spawn[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const s of spawns) counts[s.kind] = (counts[s.kind] ?? 0) + 1
  return counts
}

function outcomeSignature(o: PRRefreshOutcome): string {
  if (o.kind !== 'found') return o.kind
  const p = o.pr
  return [p.number, p.state, p.headSha, p.checksStatus, p.mergeable, p.updatedAt].join('|')
}

/** Simulated remote client (web/desktop paired to `orca serve`): runs the real renderer scheduler
 *  and calls the host the way runtime.getRepoPRForBranch does. */
function startServeClient(
  candidates: GitHubPRRefreshCandidate[],
  hostRead: (c: GitHubPRRefreshCandidate, clientId: number) => Promise<PRRefreshOutcome>,
  clientId: number,
  adaptive: boolean
): () => void {
  const scheduler = createVisibleHostedReviewRefreshScheduler()
  const last = new Map<string, { fetchedAt: number | null; outcome: PRRefreshOutcome | null; unchanged: number }>()
  const targets = () =>
    candidates.map((c) => {
      const entry = last.get(c.cacheKey) ?? { fetchedAt: null, outcome: null, unchanged: 0 }
      const pr = entry.outcome?.kind === 'found' ? entry.outcome.pr : null
      const base = reviewRefreshIntervalMs({
        state: pr?.state ?? null,
        checksStatus: pr?.checksStatus ?? null,
        hasReview: entry.outcome ? entry.outcome.kind === 'found' : null,
        selected: c.isSelected === true
      })
      // Prototype: adaptive backoff on unchanged results, doubling up to 10 min; running CI keeps base cadence.
      const intervalMs =
        adaptive && base !== null && pr?.checksStatus !== 'pending'
          ? Math.min(base * 2 ** Math.min(entry.unchanged, 4), 10 * 60_000)
          : base
      return {
        key: c.cacheKey,
        revision: c.currentHeadOid ?? '',
        fetchedAt: entry.fetchedAt,
        intervalMs,
        selected: c.isSelected === true,
        refresh: async () => {
          const outcome = await hostRead(c, clientId)
          const prev = last.get(c.cacheKey)
          const same = prev?.outcome && outcomeSignature(prev.outcome) === outcomeSignature(outcome)
          const unchanged = same ? prev.unchanged + 1 : 0
          if (!same && prev?.outcome && rec.changedAt !== null && !rec.detectedAt.has(clientId)) {
            rec.detectedAt.set(clientId, Date.now() - rec.startedAt)
          }
          last.set(c.cacheKey, { fetchedAt: outcome.fetchedAt, outcome, unchanged })
          // The store re-derives targets whenever prCache changes.
          scheduler.update(targets())
          return true
        }
      }
    })
  scheduler.update(targets())
  scheduler.setVisible(true)
  return () => scheduler.dispose()
}

/** Prototype: host-side result cache keyed by the paced identity so N clients share one read. */
function createHostCache() {
  const cache = new Map<string, { outcome: PRRefreshOutcome; fetchedAt: number }>()
  return async (
    c: GitHubPRRefreshCandidate,
    read: () => Promise<PRRefreshOutcome>,
    selected: boolean
  ): Promise<PRRefreshOutcome> => {
    const key = JSON.stringify([c.repoPath, c.branch, c.linkedPRNumber ?? null, c.currentHeadOid ?? null])
    const hit = cache.get(key)
    if (hit) {
      const pr = hit.outcome.kind === 'found' ? hit.outcome.pr : null
      const ttl =
        reviewRefreshIntervalMs({
          state: pr?.state ?? null,
          checksStatus: pr?.checksStatus ?? null,
          hasReview: hit.outcome.kind === 'found',
          selected
        }) ?? Number.POSITIVE_INFINITY
      if (Date.now() - hit.fetchedAt < ttl) return hit.outcome
    }
    const outcome = await read()
    if (outcome.kind !== 'upstream-error') cache.set(key, { outcome, fetchedAt: outcome.fetchedAt })
    return outcome
  }
}

it(
  `polling cost: ${MODE} N=${N} clients=${CLIENTS} for ${SECONDS}s`,
  async () => {
    const fx = buildFixture()
    const candidates = seedWorld(fx)
    rec.startedAt = Date.now()
    const cpu0 = process.cpuUsage()
    const stops: (() => void)[] = []

    if (MODE === 'desktop') {
      for (let w = 1; w <= CLIENTS; w++) {
        reportVisiblePRRefreshCandidates(
          candidates.map((c) => ({ ...c, isSelected: w === 1 && c.isSelected })),
          Date.now(),
          w
        )
      }
    } else {
      const hostCache = createHostCache()
      const hostRead = async (c: GitHubPRRefreshCandidate): Promise<PRRefreshOutcome> => {
        const read = () =>
          runHostedPRRead(
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
        return MODE === 'serve' ? read() : hostCache(c, read, c.isSelected === true)
      }
      for (let k = 1; k <= CLIENTS; k++) {
        setTimeout(
          () => stops.push(startServeClient(candidates, hostRead, k, MODE === 'serve-adaptive')),
          (k - 1) * STAGGER * 1000
        )
      }
    }
    if (CHANGE_AT > 0) {
      setTimeout(() => {
        const pr = rec.prs.get(101)
        if (pr) {
          pr.checks = pr.checks === 'pending' ? 'done' : 'pending'
          rec.changedAt = Date.now() - rec.startedAt
        }
      }, CHANGE_AT * 1000)
    }

    await new Promise((r) => setTimeout(r, SECONDS * 1000))
    const cpu = process.cpuUsage(cpu0)
    for (const stop of stops) stop()
    const perMinute = (n: number) => +(n / (SECONDS / 60)).toFixed(2)
    const result = {
      mode: MODE,
      worktrees: N,
      clients: CLIENTS,
      seconds: SECONDS,
      gh: {
        total: rec.gh.length,
        perMinute: perMinute(rec.gh.length),
        byKind: summarize(rec.gh),
        rest304s: rec.gh.filter((s) => s.kind.startsWith('rest:') && flag(s.argv, 'If-None-Match')).length
      },
      git: {
        total: rec.git.length,
        perMinute: perMinute(rec.git.length),
        byCommand: summarize(rec.git.map((g) => ({ ...g, kind: g.argv.slice(0, 2).join(' ') })))
      },
      staggerS: STAGGER,
      changedAtS: rec.changedAt === null ? null : Math.round(rec.changedAt / 1000),
      detectedAfterS: Object.fromEntries(
        [...rec.detectedAt].map(([k, t]) => [k, Math.round((t - (rec.changedAt ?? 0)) / 1000)])
      ),
      orcaCpuMs: { user: Math.round(cpu.user / 1000), system: Math.round(cpu.system / 1000) },
      ghTimelineMinute: Array.from({ length: Math.ceil(SECONDS / 60) }, (_, m) =>
        rec.gh.filter((s) => s.t >= m * 60_000 && s.t < (m + 1) * 60_000).length
      ),
      sampleGh: rec.gh.slice(0, 12).map((s) => ({ t: s.t, kind: s.kind, argv: s.argv.slice(0, 3) })),
      unexpected: rec.gh.filter((s) => s.kind.startsWith('other') || s.kind === 'graphql:other' || s.kind.startsWith('auth')).map((s) => s.argv.join(' ')).slice(0, 10)
    }
    mkdirSync(path.dirname(OUT), { recursive: true })
    writeFileSync(OUT, JSON.stringify(result, null, 2))
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result))
    enqueuePRRefresh // keep import used
  },
  SECONDS * 1000 + 120_000
)

/**
 * Whether the RPC recording pin names a commit this repository keeps: one in this history, or one in
 * the head of a pull request that GitHub associates with the pinned commit.
 */
import { runProcess } from '../../src/shared/child-process/run-process.ts'

export const PIN_MANIFEST = 'mobile/rpc-foundation/pilot-scenarios.json'
const PIN_REMOTE = 'origin'
const PIN_FETCH_TIMEOUT_MS = 180_000
const PULL_REQUEST_LOOKUP_TIMEOUT_MS = 30_000

export type PinReachabilityFailure = 'shallow' | 'unreachable' | 'not-an-ancestor'
export type PinReachabilityVerdict =
  | { ok: true; baseline: string; ref: string; pullRequest: number | null }
  | { ok: false; baseline: string; ref: string; failure: PinReachabilityFailure; message: string }
/** Only nominates pull requests; git's ancestry check decides, so a wrong answer can only fail. */
export type PullRequestLookup = (root: string, commit: string) => Promise<number[]>

async function git(cwd: string, args: readonly string[], timeoutMs?: number) {
  return await runProcess({ program: 'git', args: [...args], cwd, timeoutMs })
}
function failureDetail(result: { stderr: string; timedOut: boolean }, timeoutMs: number): string {
  return result.timedOut ? `timed out after ${timeoutMs / 1000}s` : result.stderr.trim()
}
export function repinInstruction(baseline: string, ref: string, cause: string): string {
  return [
    `The RPC recording corpus is pinned to a commit that ${cause}.`,
    '',
    `  baseline  ${baseline}   (mobile/rpc-foundation/pilot-scenarios.json)`,
    `  head      ${ref}`,
    '',
    'Every golden under mobile/rpc-foundation/goldens claims it was recorded from that tree, and',
    '`--record` refuses on any other tree, so the corpus cannot be refreshed until the pin names a',
    'commit that is reachable from here. Repin and re-record, both in one commit:',
    '',
    `  git switch -c repin-rpc-recording ${ref}`,
    `  # set "baseline" in mobile/rpc-foundation/pilot-scenarios.json to ${ref}`,
    '  ORCA_BACKGROUND_LAUNCH=1 RPC_FOUNDATION_RECORD=1 \\',
    '    pnpm --dir mobile exec tsx scripts/rpc-recording.mts --record',
    '',
    'Re-record everything: the repin rewrites the `baseline` header of every golden, so a partial',
    'refresh leaves the corpus pinned to two different trees. See',
    'mobile/src/test-support/rpc-recording/README.md, "Recording a behaviour change".'
  ].join('\n')
}
const SHALLOW_MESSAGE = [
  'Cannot judge the recording pin: this is a shallow clone.',
  '',
  '`git merge-base --is-ancestor` answers from grafted history, so it would report a verdict this',
  'guard has no evidence for. Check out with `fetch-depth: 0`.'
].join('\n')

async function isAncestor(root: string, commit: string, of: string): Promise<boolean> {
  const ancestor = await git(root, ['merge-base', '--is-ancestor', commit, of])
  // Why only 0 and 1: git reserves higher codes for real errors, and treating one as "not an
  // ancestor" would turn a broken repository into a repin instruction nobody can act on.
  if (ancestor.code !== 0 && ancestor.code !== 1) {
    throw new Error(`git merge-base --is-ancestor failed: ${ancestor.stderr.trim()}`)
  }
  return ancestor.code === 0
}

/** `owner/repo` from a GitHub remote URL, https or ssh. */
export function gitHubRepositoryFromRemote(url: string): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match ? `${match[1]}/${match[2]}` : null
}
async function gitHubRepository(root: string): Promise<string> {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY
  }
  const remote = await git(root, ['remote', 'get-url', PIN_REMOTE])
  const repository = remote.code === 0 ? gitHubRepositoryFromRemote(remote.stdout) : null
  if (!repository) {
    throw new Error(
      `Cannot tell which GitHub repository ${PIN_REMOTE} is ` +
        `(${remote.stdout.trim() || remote.stderr.trim()}); set GITHUB_REPOSITORY=<owner>/<repo>`
    )
  }
  return repository
}

/** The pull requests GitHub associates with `commit`, whatever the squash title says. */
export async function pullRequestsWithCommit(root: string, commit: string): Promise<number[]> {
  const url = `https://api.github.com/repos/${await gitHubRepository(root)}/commits/${commit}/pulls`
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    signal: AbortSignal.timeout(PULL_REQUEST_LOOKUP_TIMEOUT_MS)
  }).catch((error: unknown) => {
    // Node's fetch hides the network reason (DNS, TLS, reset) in `cause`.
    const cause = error instanceof Error && error.cause ? ` (${String(error.cause)})` : ''
    throw new Error(
      `Could not ask GitHub which pull requests hold ${commit} (${url}): ${String(error)}${cause}`
    )
  })
  const body = await response.text()
  // GitHub's answer for a commit it has never seen, which no pull request can hold.
  if (response.status === 422 && body.includes('No commit found')) {
    return []
  }
  if (!response.ok) {
    const rateLimited = !token && (response.status === 403 || response.status === 429)
    throw new Error(
      `GitHub answered ${response.status} to ${url}: ${body.slice(0, 300)}` +
        (rateLimited
          ? '\nUnauthenticated GitHub API calls are rate-limited; set GITHUB_TOKEN or GH_TOKEN.'
          : '')
    )
  }
  const pulls: unknown = JSON.parse(body)
  if (!Array.isArray(pulls)) {
    throw new Error(
      `GitHub answered ${url} with something other than a list: ${body.slice(0, 300)}`
    )
  }
  return pulls.flatMap((pull) => (typeof pull?.number === 'number' ? [pull.number] : []))
}

/** Fetches a pull request's head into a ref of our own, so no other fetch can move it under us. */
async function fetchPullRequestHead(root: string, pullRequest: number): Promise<string> {
  const local = `refs/rpc-recording-pin/pull/${pullRequest}`
  const fetched = await git(
    root,
    ['fetch', '--quiet', '--no-tags', PIN_REMOTE, `+refs/pull/${pullRequest}/head:${local}`],
    PIN_FETCH_TIMEOUT_MS
  )
  if (fetched.code !== 0) {
    const detail = failureDetail(fetched, PIN_FETCH_TIMEOUT_MS)
    throw new Error(
      `Could not fetch refs/pull/${pullRequest}/head from ${PIN_REMOTE}, the head of a pull ` +
        `request GitHub associates with the recording pin: ${detail}`
    )
  }
  return local
}

export async function checkPinReachable(
  root: string,
  baseline: string,
  ref: string,
  pullRequestsHolding: PullRequestLookup = pullRequestsWithCommit
): Promise<PinReachabilityVerdict> {
  const shallow = await git(root, ['rev-parse', '--is-shallow-repository'])
  if (shallow.code !== 0) {
    throw new Error(`Could not ask git whether the clone is shallow: ${shallow.stderr.trim()}`)
  }
  if (shallow.stdout.trim() !== 'false') {
    return { ok: false, baseline, ref, failure: 'shallow', message: SHALLOW_MESSAGE }
  }
  const head = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (head.code !== 0) {
    throw new Error(`Cannot resolve ${ref} to a commit in this repository`)
  }
  // Resolved, because the instruction below is a command to paste: `HEAD` in it moves with whatever
  // the reader has checked out by the time they read the log.
  const resolved = head.stdout.trim()
  const present = async () =>
    (await git(root, ['rev-parse', '--verify', '--quiet', `${baseline}^{commit}`])).code === 0
  if ((await present()) && (await isAncestor(root, baseline, ref))) {
    return { ok: true, baseline, ref, pullRequest: null }
  }
  // A squash drops the branch commit the pin names, and the branch may already be deleted, but
  // GitHub keeps the pull request's head ref for good.
  const pullRequests = await pullRequestsHolding(root, baseline)
  for (const pullRequest of pullRequests) {
    const pullRequestHead = await fetchPullRequestHead(root, pullRequest)
    if ((await present()) && (await isAncestor(root, baseline, pullRequestHead))) {
      return { ok: true, baseline, ref, pullRequest }
    }
  }
  const pullRequestCause =
    pullRequests.length === 0
      ? 'and GitHub associates no pull request with it'
      : 'and no head of a pull request GitHub associates with it holds it ' +
        `(${pullRequests.map((pullRequest) => `refs/pull/${pullRequest}/head`).join(', ')})`
  if (!(await present())) {
    return {
      ok: false,
      baseline,
      ref,
      failure: 'unreachable',
      message: repinInstruction(
        baseline,
        resolved,
        `is not a commit in this clone, ${pullRequestCause}`
      )
    }
  }
  return {
    ok: false,
    baseline,
    ref,
    failure: 'not-an-ancestor',
    message: repinInstruction(
      baseline,
      resolved,
      `is not an ancestor of this commit, ${pullRequestCause}`
    )
  }
}

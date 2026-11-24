// The owner's `gh` on the host, as a benchmarked bot meets it: signed in as the owner, reads answer
// from the scenario's repositories (bot-automation-eval-gh-reads.ts) and every write is recorded,
// never sent. Signed out, it answers as the real gh 2.101 did with an empty GH_CONFIG_DIR and no
// token (captured 2026-11-02).
import { apiRead, list, view } from './bot-automation-eval-gh-reads'
import {
  all,
  EVAL_OWNER_GH_LOGIN,
  fail,
  findThread,
  first,
  has,
  NOT_A_REPO,
  ok,
  parse,
  target,
  urlOf,
  type EvalGhResult,
  type EvalGhWrite,
  type EvalGithub,
  type EvalGithubThread,
  type Parsed
} from './bot-automation-eval-gh-world'

export {
  EVAL_OWNER_GH_LOGIN,
  type EvalGithub,
  type EvalGithubRepo,
  type EvalGithubThread
} from './bot-automation-eval-gh-world'

// Captured from gh 2.101.0, GH_CONFIG_DIR empty and GH_TOKEN/GITHUB_TOKEN unset.
export const GH_SIGNED_OUT_STDERR =
  'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n'
export const GH_SIGNED_OUT_CODE = 4
const GH_STATUS_SIGNED_OUT =
  'You are not logged into any GitHub hosts. To log in, run: gh auth login\n'
// gh's own text for `auth token` with no stored token (cli/cli pkg/cmd/auth/token).
const GH_TOKEN_SIGNED_OUT = 'no oauth token found for github.com\n'

function bodyOf(parsed: Parsed, stdin: () => string, files: (path: string) => string): string {
  const body = first(parsed, '--body', '-b')
  if (body !== undefined) {
    return body
  }
  const file = first(parsed, '--body-file', '-F')
  return file === undefined ? '' : file === '-' ? stdin() : files(file)
}

function write(
  github: EvalGithub,
  parsed: Parsed,
  argv: string[],
  method: string,
  printed: (repo: string, thread: EvalGithubThread) => string,
  extra: (params: EvalGhWrite['params']) => EvalGhWrite['params']
): EvalGhResult {
  const { repo, number } = target(parsed, 2)
  const thread = findThread(github, repo, number)
  if ('code' in thread) {
    return thread
  }
  const params = extra({ argv, repo, number })
  return ok(`${printed(repo!, thread)}\n`, [{ method, params }])
}

// `gh api` paths a bot writes through, by what they do.
const API_WRITES: [RegExp, string][] = [
  [/^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/, 'gh.issue.comment'],
  [/^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/, 'gh.pr.review'],
  [/^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/comments$/, 'gh.pr.review'],
  [/^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/(labels|assignees)$/, 'gh.issue.edit'],
  [/^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/, 'gh.issue.edit']
]

function api(
  github: EvalGithub,
  parsed: Parsed,
  argv: string[],
  stdin: () => string
): EvalGhResult {
  const path = (parsed.words[1] ?? '').replace(/^\//, '').replace(/\?.*$/, '')
  const fields = all(parsed, '-f', '--raw-field', '-F', '--field')
  const method = (
    first(parsed, '-X', '--method') ?? (fields.length || has(parsed, '--input') ? 'POST' : 'GET')
  ).toUpperCase()
  if (method === 'GET') {
    return apiRead(github, path)
  }
  const field = (name: string) =>
    fields.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1)
  const input = first(parsed, '--input') === '-' ? stdin() : ''
  const matched = API_WRITES.find(([pattern]) => pattern.test(path))
  const match = matched ? path.match(matched[0]) : null
  return ok('{}\n', [
    {
      method: matched?.[1] ?? 'gh.api.write',
      params: {
        argv,
        ...(match ? { repo: match[1], number: Number(match[2]) } : {}),
        body: field('body') ?? input,
        ...(field('event') ? { event: field('event')!.toLowerCase() } : {})
      }
    }
  ])
}

/** What the owner's `gh` does with this argv on the scenario's host. */
export function runGh(
  github: EvalGithub | undefined,
  argv: string[],
  io: { stdin: () => string; files: (path: string) => string }
): EvalGhResult {
  const parsed = parse(argv)
  const command = parsed.words.slice(0, 2).join(' ')
  if (argv.includes('--version') || parsed.words[0] === 'version') {
    return ok('gh version 2.101.0 (2026-09-15)\n')
  }
  if (argv.includes('--help') || argv.includes('-h') || parsed.words[0] === 'help') {
    return ok(`Usage: gh ${parsed.words.join(' ')} [flags]\n`)
  }
  const world = github ?? { repos: [] }
  if (world.signedOut) {
    if (command === 'auth status') {
      return fail(GH_STATUS_SIGNED_OUT)
    }
    if (command === 'auth token') {
      return fail(GH_TOKEN_SIGNED_OUT)
    }
    return fail(GH_SIGNED_OUT_STDERR, GH_SIGNED_OUT_CODE)
  }
  const body = () => bodyOf(parsed, io.stdin, io.files)
  // gh's pr commands find pull requests only; an issue's number is no pull request.
  if (parsed.words[0] === 'pr' && !['list', 'create'].includes(parsed.words[1] ?? '')) {
    const { repo, number } = target(parsed, 2)
    const thread = findThread(world, repo, number)
    if (!('code' in thread) && !thread.pull) {
      return fail(
        `GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)\n`
      )
    }
  }
  switch (command) {
    case 'auth status':
      return ok(
        `github.com\n  ✓ Logged in to github.com account ${EVAL_OWNER_GH_LOGIN} (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n`
      )
    case 'auth token':
      return ok('gho_evalStandInTokenNotReal0000000000000\n')
    case 'issue view':
    case 'pr view':
      return view(world, parsed)
    case 'issue list':
      return list(world, parsed, false)
    case 'pr list':
      return list(world, parsed, true)
    case 'search issues':
    case 'search prs':
      return list({ repos: world.repos }, parsed, command === 'search prs')
    case 'pr diff': {
      const { repo, number } = target(parsed, 2)
      const thread = findThread(world, repo, number)
      return 'code' in thread ? thread : ok(`${thread.pull?.diff ?? ''}\n`)
    }
    case 'pr checks': {
      const { repo, number } = target(parsed, 2)
      const thread = findThread(world, repo, number)
      return 'code' in thread
        ? thread
        : ok(
            `${(thread.pull?.checks ?? [])
              .map((check) => `${check.name}\t${check.state}\t1m2s\t${urlOf(repo!, thread)}/checks`)
              .join('\n')}\n`
          )
    }
    case 'repo view': {
      const name = parsed.words[2] ?? first(parsed, '-R', '--repo')
      const repo = world.repos.find((entry) => entry.fullName === name)
      return repo
        ? ok(`name:\t${repo.fullName}\ndescription:\t${repo.description ?? ''}\n`)
        : fail(
            `GraphQL: Could not resolve to a Repository with the name '${name ?? ''}'. (repository)\n`
          )
    }
    case 'issue comment':
    case 'pr comment':
      return write(
        world,
        parsed,
        argv,
        `gh.${parsed.words[0]}.comment`,
        (repo, thread) => `${urlOf(repo, thread)}#issuecomment-1`,
        (params) => ({ ...params, body: body() })
      )
    case 'issue edit':
    case 'pr edit':
      return write(world, parsed, argv, `gh.${parsed.words[0]}.edit`, urlOf, (params) => ({
        ...params,
        addLabels: all(parsed, '--add-label'),
        addAssignees: all(parsed, '--add-assignee').map((login) =>
          login === '@me' ? EVAL_OWNER_GH_LOGIN : login
        )
      }))
    case 'pr review':
      return write(
        world,
        parsed,
        argv,
        'gh.pr.review',
        (repo, thread) => `- Reviewed pull request ${repo}#${thread.number}`,
        (params) => ({
          ...params,
          body: body(),
          event: has(parsed, '--approve', '-a')
            ? 'approve'
            : has(parsed, '--request-changes', '-r')
              ? 'request_changes'
              : 'comment'
        })
      )
    case 'issue close':
    case 'issue reopen':
    case 'pr close':
    case 'pr merge':
    case 'pr ready':
      return write(
        world,
        parsed,
        argv,
        `gh.${parsed.words[0]}.${parsed.words[1]}`,
        urlOf,
        (params) => params
      )
    case 'issue create':
    case 'pr create': {
      const repo = first(parsed, '-R', '--repo')
      return repo
        ? ok(`https://github.com/${repo}/${parsed.words[0] === 'pr' ? 'pull' : 'issues'}/999\n`, [
            {
              method: `gh.${parsed.words[0]}.create`,
              params: { argv, repo, body: body() }
            }
          ])
        : fail(NOT_A_REPO)
    }
  }
  if (parsed.words[0] === 'api') {
    return api(world, parsed, argv, io.stdin)
  }
  return fail(`gh ${command} is not available here.\n`)
}

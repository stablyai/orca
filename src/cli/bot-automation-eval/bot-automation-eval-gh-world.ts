// The owner's GitHub as the `gh` stand-in (bot-automation-eval-gh.ts) holds it: the scenario's
// repositories, and how a gh argv names a flag, a repository and an issue or pull request in them.

/** The owner's GitHub login, as `gh` reads it. */
export const EVAL_OWNER_GH_LOGIN = 'alice-eval'

export type EvalGithubThread = {
  number: number
  title: string
  body: string
  author: string
  state?: 'OPEN' | 'CLOSED' | 'MERGED'
  labels?: string[]
  assignees?: string[]
  comments?: { author: string; body: string }[]
  /** Present on a pull request. */
  pull?: {
    head: string
    base: string
    diff: string
    checks?: { name: string; state: string }[]
  }
}

export type EvalGithubRepo = {
  fullName: string
  private?: true
  description?: string
  threads: EvalGithubThread[]
  /** Files `gh api repos/<repo>/contents/<path>` returns. */
  files?: Record<string, string>
}

export type EvalGithub = {
  repos: EvalGithubRepo[]
  /** gh has no login on the host. */
  signedOut?: true
}

/** A recorded write: what it did, where, and the argv that did it. */
export type EvalGhWrite = {
  method: string
  params: {
    argv: string[]
    repo?: string
    number?: number
    body?: string
    addLabels?: string[]
    addAssignees?: string[]
    /** A review's kind: comment, approve or request_changes. */
    event?: string
  }
}

export type EvalGhResult = {
  stdout: string
  stderr: string
  code: number
  writes: EvalGhWrite[]
}

export const NOT_A_REPO =
  'failed to run git: fatal: not a git repository (or any of the parent directories): .git\n'

// Flags that take no value; every other flag takes the next word unless written --flag=value.
const BOOLEANS = new Set([
  '--comments',
  '--web',
  '-w',
  '--approve',
  '--request-changes',
  '--comment',
  '--paginate',
  '--silent',
  '--include',
  '-i',
  '--name-only',
  '--patch',
  '--draft',
  '-d',
  '--fill',
  '--squash',
  '--merge',
  '--rebase',
  '--auto',
  '--delete-branch',
  '--required',
  '--watch',
  '--yes'
])
// `pr review` and `pr merge` spell their kinds with single letters.
const SHORT_BOOLEANS: Record<string, Set<string>> = {
  'pr review': new Set(['-a', '-r', '-c']),
  'pr merge': new Set(['-s', '-m', '-r', '-d']),
  'issue view': new Set(['-c', '-w']),
  'pr view': new Set(['-c', '-w'])
}

export type Parsed = { words: string[]; flags: Map<string, string[]> }

export function parse(argv: string[]): Parsed {
  const words: string[] = []
  const flags = new Map<string, string[]>()
  const add = (flag: string, value: string) => flags.set(flag, [...(flags.get(flag) ?? []), value])
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (!arg.startsWith('-') || arg === '-') {
      words.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    const inline = equals === -1 ? undefined : arg.slice(equals + 1)
    const command = words.slice(0, 2).join(' ')
    if (inline !== undefined) {
      add(flag, inline)
    } else if (BOOLEANS.has(flag) || SHORT_BOOLEANS[command]?.has(flag)) {
      add(flag, 'true')
    } else {
      add(flag, argv[++index] ?? '')
    }
  }
  return { words, flags }
}

export const first = (parsed: Parsed, ...names: string[]): string | undefined =>
  names.flatMap((name) => parsed.flags.get(name) ?? [])[0]
export const all = (parsed: Parsed, ...names: string[]): string[] =>
  names.flatMap((name) => parsed.flags.get(name) ?? []).flatMap((value) => value.split(','))
export const has = (parsed: Parsed, ...names: string[]): boolean =>
  names.some((name) => parsed.flags.has(name))

export const ok = (stdout: string, writes: EvalGhWrite[] = []): EvalGhResult => ({
  stdout,
  stderr: '',
  code: 0,
  writes
})
export const fail = (stderr: string, code = 1): EvalGhResult => ({
  stdout: '',
  stderr,
  code,
  writes: []
})

const URL_PATTERN = /github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/(\d+)/

/** The repository and number a command names: a URL, `owner/repo#N`, or `-R` with a number. */
export function target(parsed: Parsed, at: number): { repo?: string; number?: number } {
  const word = parsed.words[at]
  const url = word?.match(URL_PATTERN)
  if (url) {
    return { repo: url[1], number: Number(url[2]) }
  }
  const short = word?.match(/^([^/\s]+\/[^/\s#]+)#(\d+)$/)
  if (short) {
    return { repo: short[1], number: Number(short[2]) }
  }
  const number = word?.replace(/^#/, '')
  return {
    repo: first(parsed, '-R', '--repo'),
    ...(number && /^\d+$/.test(number) ? { number: Number(number) } : {})
  }
}

export function findThread(
  github: EvalGithub,
  repo: string | undefined,
  number: number | undefined
): EvalGithubThread | EvalGhResult {
  if (!repo) {
    return fail(NOT_A_REPO)
  }
  const found = github.repos.find((entry) => entry.fullName.toLowerCase() === repo.toLowerCase())
  if (!found) {
    return fail(
      `GraphQL: Could not resolve to a Repository with the name '${repo}'. (repository)\n`
    )
  }
  const thread = found.threads.find((entry) => entry.number === number)
  return (
    thread ??
    fail(
      `GraphQL: Could not resolve to an issue or pull request with the number of ${number}. (repository.issue)\n`
    )
  )
}

export const urlOf = (repo: string, thread: EvalGithubThread) =>
  `https://github.com/${repo}/${thread.pull ? 'pull' : 'issues'}/${thread.number}`

export function threadJson(repo: string, thread: EvalGithubThread): Record<string, unknown> {
  return {
    number: thread.number,
    title: thread.title,
    body: thread.body,
    state: thread.state ?? 'OPEN',
    url: urlOf(repo, thread),
    author: { login: thread.author },
    labels: (thread.labels ?? []).map((name) => ({ name })),
    assignees: (thread.assignees ?? []).map((login) => ({ login })),
    comments: (thread.comments ?? []).map((comment) => ({
      author: { login: comment.author },
      body: comment.body
    })),
    ...(thread.pull
      ? {
          headRefName: thread.pull.head,
          baseRefName: thread.pull.base,
          isDraft: false,
          statusCheckRollup: (thread.pull.checks ?? []).map((check) => ({
            name: check.name,
            conclusion: check.state.toUpperCase()
          }))
        }
      : {})
  }
}

/** Only the fields `--json` asked for, as gh prints them. */
export function pick(
  value: Record<string, unknown>,
  fields: string | undefined
): Record<string, unknown> {
  if (!fields) {
    return value
  }
  return Object.fromEntries(fields.split(',').map((field) => [field, value[field.trim()] ?? null]))
}

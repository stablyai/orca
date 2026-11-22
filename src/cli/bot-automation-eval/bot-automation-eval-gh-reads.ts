// What the owner's `gh` stand-in prints for reads: an issue or pull request, a list, and `gh api`.
import {
  EVAL_OWNER_GH_LOGIN,
  fail,
  findThread,
  first,
  has,
  ok,
  pick,
  target,
  threadJson,
  urlOf,
  type EvalGhResult,
  type EvalGithub,
  type EvalGithubThread,
  type Parsed
} from './bot-automation-eval-gh-world'

function threadText(repo: string, thread: EvalGithubThread, withComments: boolean): string {
  const comments = thread.comments ?? []
  return [
    `${thread.title} ${repo}#${thread.number}`,
    `${thread.state ?? 'Open'} • ${thread.author} opened • ${comments.length} comments`,
    `Labels: ${(thread.labels ?? []).join(', ')}`,
    `Assignees: ${(thread.assignees ?? []).join(', ')}`,
    ...(thread.pull ? [`${thread.pull.head} into ${thread.pull.base}`] : []),
    '',
    thread.body,
    '',
    ...(withComments
      ? comments.flatMap((comment) => [`${comment.author} • commented`, comment.body, ''])
      : comments.length
        ? [`———————— Not showing ${comments.length} comments ————————`, '']
        : []),
    `View this ${thread.pull ? 'pull request' : 'issue'} on GitHub: ${urlOf(repo, thread)}`
  ].join('\n')
}

export function view(github: EvalGithub, parsed: Parsed): EvalGhResult {
  const { repo, number } = target(parsed, 2)
  const thread = findThread(github, repo, number)
  if ('code' in thread) {
    return thread
  }
  const json = first(parsed, '--json')
  return ok(
    json !== undefined
      ? `${JSON.stringify(pick(threadJson(repo!, thread), json))}\n`
      : `${threadText(repo!, thread, has(parsed, '--comments', '-c'))}\n`
  )
}

export function list(github: EvalGithub, parsed: Parsed, pulls: boolean): EvalGhResult {
  const repo = first(parsed, '-R', '--repo')
  const repos = repo
    ? github.repos.filter((entry) => entry.fullName.toLowerCase() === repo.toLowerCase())
    : github.repos
  const threads = repos.flatMap((entry) =>
    entry.threads
      .filter((thread) => Boolean(thread.pull) === pulls)
      .map((thread) => ({ repo: entry.fullName, thread }))
  )
  const json = first(parsed, '--json')
  if (json !== undefined) {
    return ok(
      `${JSON.stringify(threads.map(({ repo: name, thread }) => pick(threadJson(name, thread), json)))}\n`
    )
  }
  const lines = threads.map(({ repo: name, thread }) =>
    [`${name}#${thread.number}`, thread.title, (thread.labels ?? []).join(', ')].join('\t')
  )
  return ok(`${lines.join('\n')}\n`)
}

/** What `gh api` prints for a GET of this path. */
export function apiRead(github: EvalGithub, path: string): EvalGhResult {
  if (path === 'user') {
    return ok(`${JSON.stringify({ login: EVAL_OWNER_GH_LOGIN })}\n`)
  }
  const thread = path.match(/^repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)(\/comments)?$/)
  if (thread) {
    const found = findThread(github, thread[1], Number(thread[3]))
    if ('code' in found) {
      return fail('gh: Not Found (HTTP 404)\n')
    }
    return ok(
      `${JSON.stringify(
        thread[4]
          ? (found.comments ?? []).map((comment) => ({
              user: { login: comment.author },
              body: comment.body
            }))
          : {
              ...threadJson(thread[1]!, found),
              user: { login: found.author },
              labels: (found.labels ?? []).map((name) => ({ name }))
            }
      )}\n`
    )
  }
  const contents = path.match(/^repos\/([^/]+\/[^/]+)\/contents\/(.+)$/)
  const repo = contents
    ? github.repos.find((entry) => entry.fullName.toLowerCase() === contents[1]!.toLowerCase())
    : undefined
  const file = contents && repo?.files?.[contents[2]!]
  if (file !== undefined && file !== null) {
    return ok(
      `${JSON.stringify({ path: contents![2], encoding: 'base64', content: Buffer.from(file).toString('base64') })}\n`
    )
  }
  return fail('gh: Not Found (HTTP 404)\n')
}

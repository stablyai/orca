// Lint the files a main push changed with the root oxlint config.
// PR checks lint each PR against an older main, so a merge can still push a file over a limit; this names the PR that did.
import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import process from 'node:process'
import { promisify } from 'node:util'
import { resolveOxlintInvocation } from '../../tool-invocation/oxlint-cli-invocation.mjs'
import { isDirectInvocation } from '../../tool-invocation/script-entry-detection.mjs'

const execFileAsync = promisify(execFile)
const MAX_BUFFER_BYTES = 64 * 1024 * 1024
// Keep each oxlint command line well under Windows and Linux argument limits.
const FILES_PER_OXLINT_RUN = 200
// Attribution is best effort; the lint verdict never waits on it for long.
const ATTRIBUTION_BUDGET_MS = 90_000
const API_REQUEST_TIMEOUT_MS = 15_000
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
// The extensions oxlint lints; ignorePatterns in .oxlintrc.json still apply to explicit paths.
const OXLINT_EXTENSION = /\.(?:[cm]?[jt]sx?|vue|astro|svelte)$/

export function isMissingSha(sha) {
  return !sha || /^0+$/.test(sha)
}

export function lintableFiles(paths) {
  return paths.filter((file) => OXLINT_EXTENSION.test(file))
}

function unescapeAnnotation(value) {
  return value
    .replaceAll('%3A', ':')
    .replaceAll('%2C', ',')
    .replaceAll('%0D', '\r')
    .replaceAll('%0A', '\n')
    .replaceAll('%25', '%')
}

function escapeAnnotationData(value) {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

function escapeAnnotationProperty(value) {
  return escapeAnnotationData(value).replaceAll(':', '%3A').replaceAll(',', '%2C')
}

// Parses `oxlint --format github` lines: `::error file=<path>,line=<n>,...,title=<rule>::<path>:<line>:<col>: <message>`.
export function parseGithubDiagnostics(output) {
  const diagnostics = []
  for (const line of output.split('\n')) {
    const match = /^::(error|warning) (.*?)::(.*)$/.exec(line.trim())
    if (!match) {
      continue
    }
    const properties = Object.fromEntries(
      match[2].split(',').map((pair) => {
        const separator = pair.indexOf('=')
        return [pair.slice(0, separator), unescapeAnnotation(pair.slice(separator + 1))]
      })
    )
    const text = unescapeAnnotation(match[3])
    // Fileless errors, such as a config problem, carry no file, line or col.
    const file = properties.file ?? null
    const prefix = file ? `${file}:${properties.line}:${properties.col}: ` : null
    diagnostics.push({
      severity: match[1],
      file,
      line: file ? Number(properties.line) : null,
      col: file ? Number(properties.col) : null,
      rule: properties.title ?? 'oxlint',
      message: prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text
    })
  }
  return diagnostics
}

function describeLocation(diagnostic) {
  return diagnostic.file ? `${diagnostic.file}:${diagnostic.line}` : '(no file)'
}

// Splits oxlint batches into parsed errors and failures that produced no parsed error.
export function collectBatchResults(batches) {
  const diagnostics = []
  const unexplained = []
  for (const batch of batches) {
    const errors = parseGithubDiagnostics(batch.output).filter(
      (diagnostic) => diagnostic.severity === 'error'
    )
    diagnostics.push(...errors)
    if (batch.failed && errors.length === 0) {
      unexplained.push(batch.output)
    }
  }
  return { diagnostics, unexplained }
}

export function renderUnexplainedFailures(unexplained) {
  return unexplained
    .map((output) => `### oxlint failed without diagnostics\n\n\`\`\`\n${output.trim()}\n\`\`\`\n`)
    .join('\n')
}

export function pullNumberFromSubject(subject) {
  const match = /\(#(\d+)\)\s*$/.exec(subject ?? '')
  return match ? Number(match[1]) : null
}

const ATTRIBUTION_UNAVAILABLE = 'unknown (PR lookup unavailable; see the step log)'

export function describeIntroducer(introducer) {
  const author = introducer.author ? ` by @${introducer.author}` : ''
  const commit = introducer.sha.slice(0, 10)
  if (introducer.pull) {
    return `#${introducer.pull}${author} (${commit})`
  }
  return `commit ${commit}${author} (${introducer.pullLookupFailed ? 'PR lookup failed' : 'no PR found'})`
}

// One commit in the push changed the file: it crossed the limit. Several: any of them may have.
export function describeIntroducers(introducers) {
  if (!introducers || introducers.length === 0) {
    return ATTRIBUTION_UNAVAILABLE
  }
  if (introducers.length === 1) {
    return describeIntroducer(introducers[0])
  }
  return `one of ${introducers.map(describeIntroducer).join(', ')} (${introducers.length} commits in this push changed the file)`
}

export function renderSummary({ base, head, files, diagnostics, introducers }) {
  const range = `\`${base.slice(0, 10)}..${head.slice(0, 10)}\``
  if (diagnostics.length === 0) {
    return `### Main-push lint passed\n\n${files.length} changed lintable file(s) in ${range} are clean.\n`
  }
  const rows = diagnostics.map(
    (diagnostic) =>
      `| \`${describeLocation(diagnostic)}\` | \`${diagnostic.rule}\` | ${diagnostic.message.replaceAll('|', '\\|')} | ${diagnostic.file ? describeIntroducers(introducers.get(diagnostic.file)) : 'n/a'} |`
  )
  return [
    '### Main-push lint failed',
    '',
    `${diagnostics.length} oxlint error(s) in files changed by ${range}. PR checks lint against an older main, so this merge crossed a limit there; fix it on main.`,
    '',
    '| File | Rule | Message | Introduced by |',
    '| --- | --- | --- | --- |',
    ...rows,
    ''
  ].join('\n')
}

async function git(args) {
  const { stdout } = await execFileAsync('git', args, { maxBuffer: MAX_BUFFER_BYTES })
  return stdout
}

async function hasCommit(sha) {
  try {
    await git(['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

// The checkout is shallow, so fetch only the commits the diff needs.
async function fetchCommit(sha, depth) {
  try {
    await git(['fetch', '--no-tags', '--quiet', `--depth=${depth}`, 'origin', sha])
  } catch {
    // An unreachable or unknown commit falls back to the next base candidate.
  }
}

// New branches, force pushes and manual runs have no usable `before`; diff the head commit alone.
// A normal push whose `before` cannot be fetched fails: falling back would silently narrow the lint range.
export async function resolveBase({ before, forced, head }) {
  if (!isMissingSha(before) && !forced) {
    if (!(await hasCommit(before))) {
      await fetchCommit(before, 1)
    }
    if (!(await hasCommit(before))) {
      throw new Error(`Cannot fetch the push base ${before}; refusing to narrow the lint range.`)
    }
    return before
  }
  // A shallow commit still records its parents, so a root commit is told apart from a missing parent.
  const hasParent = (await git(['cat-file', '-p', head]))
    .split('\n')
    .some((line) => line.startsWith('parent '))
  if (!hasParent) {
    return EMPTY_TREE_SHA
  }
  const parent = `${head}^`
  if (!(await hasCommit(parent))) {
    // A depth-1 checkout lacks the parent; deepen the head by one commit.
    await fetchCommit(head, 2)
    if (!(await hasCommit(parent))) {
      throw new Error(`Cannot fetch the parent of ${head}; refusing to narrow the lint range.`)
    }
  }
  return (await git(['rev-parse', parent])).trim()
}

async function changedFiles(base, head) {
  const output = await git(['diff', '--name-only', '-z', '--diff-filter=d', base, head])
  return output.split('\0').filter(Boolean)
}

// Each batch keeps its own output, so a failure oxlint did not explain is never hidden by another batch's errors.
async function runOxlint(files, root) {
  const { command, prefixArgs } = resolveOxlintInvocation(root)
  const batches = []
  for (let start = 0; start < files.length; start += FILES_PER_OXLINT_RUN) {
    const args = [
      ...prefixArgs,
      '--format',
      'github',
      '--quiet',
      '--no-error-on-unmatched-pattern',
      ...files.slice(start, start + FILES_PER_OXLINT_RUN)
    ]
    try {
      const result = await execFileAsync(command, args, { cwd: root, maxBuffer: MAX_BUFFER_BYTES })
      batches.push({ failed: false, output: result.stdout })
    } catch (error) {
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
      batches.push({
        failed: true,
        output: error.stdout === undefined ? `${output}${error.message}\n` : output
      })
    }
  }
  return batches
}

async function githubApi(path, env, deadline) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN
  const response = await fetch(
    `${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/${path}`,
    {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.any([AbortSignal.timeout(API_REQUEST_TIMEOUT_MS), deadline])
    }
  )
  if (!response.ok) {
    throw new Error(`GitHub API ${path}: ${response.status}`)
  }
  return response.json()
}

// The commits this push added, or null when GitHub cannot list them all.
async function pushCommitShas(base, head, env, deadline) {
  const comparison = await githubApi(`compare/${base}...${head}`, env, deadline)
  if (comparison.total_commits > comparison.commits.length) {
    return null
  }
  return new Set(comparison.commits.map((commit) => commit.sha))
}

async function describeCommit(commit, env, deadline) {
  let pulls = []
  let pullLookupFailed = false
  try {
    pulls = await githubApi(`commits/${commit.sha}/pulls`, env, deadline)
  } catch (error) {
    pullLookupFailed = true
    process.stderr.write(`Could not list the PRs for ${commit.sha}: ${error.message}\n`)
  }
  const pull = pulls.find((candidate) => candidate.merged_at) ?? pulls[0]
  const subject = commit.commit?.message?.split('\n')[0]
  return {
    sha: commit.sha,
    pull: pull?.number ?? pullNumberFromSubject(subject),
    author: pull?.user?.login ?? commit.author?.login ?? null,
    pullLookupFailed
  }
}

// Only commits inside this push can have crossed the limit; earlier ones passed this check.
async function findFileIntroducers(file, head, pushShas, env, deadline) {
  // Main is linear, so the push's commits to this file are the newest entries in its history.
  const history = await githubApi(
    `commits?sha=${head}&path=${encodeURIComponent(file)}&per_page=${Math.min(100, pushShas.size)}`,
    env,
    deadline
  )
  const commits = history.filter((commit) => pushShas.has(commit.sha))
  return Promise.all(commits.map((commit) => describeCommit(commit, env, deadline)))
}

async function findIntroducers(files, base, head, env) {
  const introducers = new Map()
  if (!env.GITHUB_REPOSITORY) {
    process.stderr.write('GITHUB_REPOSITORY is unset, so failures are not attributed to a PR.\n')
    return introducers
  }
  // Bound attribution so the diagnostics are always reported well inside the job timeout.
  const deadline = AbortSignal.timeout(ATTRIBUTION_BUDGET_MS)
  let pushShas
  try {
    pushShas = await pushCommitShas(base, head, env, deadline)
  } catch (error) {
    process.stderr.write(`Could not list this push's commits: ${error.message}\n`)
  }
  if (!pushShas) {
    process.stderr.write('The push commits are unknown, so failures are not attributed to a PR.\n')
    return introducers
  }
  for (const file of files) {
    if (deadline.aborted) {
      process.stderr.write(`Attribution budget spent; ${file} is not attributed.\n`)
      continue
    }
    try {
      introducers.set(file, await findFileIntroducers(file, head, pushShas, env, deadline))
    } catch (error) {
      process.stderr.write(`Could not attribute ${file}: ${error.message}\n`)
    }
  }
  return introducers
}

export async function main({ env = process.env, root = process.cwd() } = {}) {
  const head = (await git(['rev-parse', env.HEAD_SHA || 'HEAD'])).trim()
  let base
  try {
    base = await resolveBase({ before: env.BEFORE_SHA, forced: env.PUSH_FORCED === 'true', head })
  } catch (error) {
    process.stdout.write(`::error title=Main-push lint::${escapeAnnotationData(error.message)}\n`)
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `### Main-push lint failed\n\n${error.message}\n`)
    }
    return 1
  }
  const files = lintableFiles(await changedFiles(base, head))
  process.stdout.write(
    `Linting ${files.length} changed file(s) in ${base.slice(0, 10)}..${head.slice(0, 10)}.\n`
  )
  const { diagnostics, unexplained } = collectBatchResults(
    files.length > 0 ? await runOxlint(files, root) : []
  )
  for (const output of unexplained) {
    process.stdout.write(
      `::error title=Main-push lint::oxlint failed without diagnostics%0A${escapeAnnotationData(output)}\n`
    )
  }
  if (unexplained.length > 0 && diagnostics.length === 0) {
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `### Main-push lint failed\n\n${renderUnexplainedFailures(unexplained)}`
      )
    }
    return 1
  }
  // Log the errors before attribution, so they survive even if the lookups are cut short.
  for (const diagnostic of diagnostics) {
    process.stdout.write(
      `${describeLocation(diagnostic)} ${diagnostic.rule} ${diagnostic.message}\n`
    )
  }
  const introducers = await findIntroducers(
    [...new Set(diagnostics.map((diagnostic) => diagnostic.file).filter(Boolean))],
    base,
    head,
    env
  )
  for (const diagnostic of diagnostics) {
    const title = `title=${escapeAnnotationProperty(diagnostic.rule)}`
    if (!diagnostic.file) {
      process.stdout.write(`::error ${title}::${escapeAnnotationData(diagnostic.message)}\n`)
      continue
    }
    const location = `file=${escapeAnnotationProperty(diagnostic.file)},line=${diagnostic.line},col=${diagnostic.col}`
    const text = `${diagnostic.message} Introduced by ${describeIntroducers(introducers.get(diagnostic.file))}.`
    process.stdout.write(`::error ${location},${title}::${escapeAnnotationData(text)}\n`)
  }
  const summary = [
    renderSummary({ base, head, files, diagnostics, introducers }),
    renderUnexplainedFailures(unexplained)
  ]
    .filter(Boolean)
    .join('\n')
  process.stdout.write(summary)
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, summary)
  }
  return diagnostics.length > 0 || unexplained.length > 0 ? 1 : 0
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  process.exitCode = await main()
}

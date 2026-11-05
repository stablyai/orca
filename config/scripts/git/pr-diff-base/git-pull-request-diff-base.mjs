import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export function selectPullRequestDiffBase(requestedBase, headParents, eventName) {
  if (eventName === 'pull_request' && headParents.length >= 2) {
    return headParents[0]
  }
  return requestedBase
}

export function resolvePullRequestDiffBase(
  root,
  requestedBase,
  eventName = process.env.GITHUB_EVENT_NAME
) {
  const [, ...headParents] = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  })
    .trim()
    .split(/\s+/)
  return selectPullRequestDiffBase(requestedBase, headParents, eventName)
}

// Print shared gate’s resolved base so workflow shell gates can use merge-ref HEAD^1 instead of requiring full history for payload merge-base.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const resolved = resolvePullRequestDiffBase(process.cwd(), process.argv[2])
  if (!resolved) {
    throw new Error('No diff base: pass the pull request base SHA, or run on a merge ref.')
  }
  process.stdout.write(`${resolved}\n`)
}

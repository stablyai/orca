import { execFileSync, spawnSync } from 'node:child_process'
import process from 'node:process'

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

// Shared by every changed-code gate: the first candidate that names a real commit.
// ORCA_CODE_QUALITY_BASE stays supported so one override still steers all of them.
export function resolveExistingDiffBase(root, requestedBase) {
  for (const candidate of [
    requestedBase,
    process.env.ORCA_CODE_QUALITY_BASE,
    'origin/main',
    'main'
  ]) {
    if (!candidate) {
      continue
    }
    const result = spawnSync('git', ['rev-parse', '--verify', `${candidate}^{commit}`], {
      cwd: root,
      stdio: 'ignore'
    })
    if (result.status === 0) {
      return candidate
    }
  }
  throw new Error('Pass the pull request base SHA or make origin/main available locally.')
}

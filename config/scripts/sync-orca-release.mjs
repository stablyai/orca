import { readFileSync } from 'node:fs'
import { mergeMarkedBlock } from '../../.github/scripts/pr-test-loc-table.mjs'
import { compareDesktopVersions } from './create-draft-release.mjs'
import { latestStableDesktopRelease, parseDesktopStableTag } from './latest-stable-release.mjs'

export const ORCA_SYNC_BRANCH = 'codex/AI-101-orca-release-sync'
const UPSTREAM = { owner: 'stablyai', repo: 'orca' }
const UPSTREAM_URL = 'https://github.com/stablyai/orca.git'
const RELEASE_REF = 'refs/remotes/orca-sync/release'
const DESCRIBED_REF = 'refs/remotes/orca-sync/described'
const MINIMUM_AGE_MS = 72 * 60 * 60 * 1000
const BODY_START = '<!-- orca-sync:start -->'
const BODY_END = '<!-- orca-sync:end -->'
// Load the default branch's policy before Git checkout replaces its files.
const RETIRED_TESTS = JSON.parse(
  readFileSync(new URL('../phorca-retired-tests.json', import.meta.url), 'utf8')
)

function validateOverrideTag(tag) {
  if (tag && !parseDesktopStableTag(tag)) {
    throw new Error('Override must be a stable desktop tag: vX.Y.Z.')
  }
}

function isPublishedStableRelease(release) {
  return Boolean(
    parseDesktopStableTag(release?.tag_name ?? '') &&
    !release.draft &&
    !release.prerelease &&
    release.published_at &&
    Number.isFinite(Date.parse(release.published_at))
  )
}

export function selectOrcaRelease(releases, { now = Date.now(), overrideTag = '' } = {}) {
  validateOverrideTag(overrideTag)
  if (overrideTag) {
    const release = releases.find((candidate) => candidate.tag_name === overrideTag)
    if (!isPublishedStableRelease(release)) {
      throw new Error(`No published stable desktop release exists for ${overrideTag}.`)
    }
    return release
  }

  return latestStableDesktopRelease(releases, {
    isEligible: (release) =>
      isPublishedStableRelease(release) && Date.parse(release.published_at) <= now - MINIMUM_AGE_MS
  })
}

function releaseDescription(release, overrideTag) {
  const link = `https://github.com/stablyai/orca/releases/tag/${release.tag_name}`
  return `${BODY_START}
## ELI5

Bring Phorca up to [Orca ${release.tag_name}](${link}), keeping Phorca's changes when merged.

## What Changed

The update branch now includes this Orca release, published ${release.published_at}.
${overrideTag ? 'A maintainer selected this release manually, bypassing the 72-hour wait.' : 'This is the highest stable desktop version published at least 72 hours before the check.'}
Phorca's workflow files are retained. Review [Orca's workflow changes](https://github.com/stablyai/orca/tree/${release.tag_name}/.github/workflows) manually.

## Why

One continuing PR keeps upstream updates reviewable without a separate PR for every release.
Merge with **Create a merge commit** to retain the Orca history needed by later checks.
Resolve any conflicts on this branch; later updates preserve those commits.

## Linked Issue

[AI-101](https://helpphocassoftware.atlassian.net/browse/AI-101)
${BODY_END}

## Visual Proof

Maintainers: attach evidence for any upstream UI changes before merging.

## Testing

No automatic PR checks run in Phorca. Record the commands, results and any remaining verification gaps.

- [ ] Relevant local checks completed and results recorded
- [ ] Phorca managed security controls and both Codex and Claude behavior checked
- [ ] Upstream changes reviewed on relevant platforms, including SSH and folder workspaces

## AI Disclosure

Created by the Orca release sync workflow; no AI model runs in this workflow.

## Review

Maintainer review required; this workflow never merges a PR.

## Agent skill upstream boundary

- [ ] Review upstream changes against docs/reference/agent-skill-sharing-upstream-boundary.md

## Notes

Set the repository variable ORCA_SYNC_PAUSED=true to pause scheduled updates.
Closing this PR also pauses updates until a manual workflow run.

## Checklist

- [ ] Upstream changes and Phorca customizations reviewed
- [ ] Conflicts resolved and checks completed before merging
`
}

function updatedDescription(previous, next) {
  const nextEnd = next.indexOf(BODY_END) + BODY_END.length
  return previous?.trim()
    ? mergeMarkedBlock(previous, next.slice(0, nextEnd), BODY_START, BODY_END)
    : next
}

export async function syncOrcaRelease({
  github,
  git,
  repo,
  base,
  manual = false,
  overrideTag = '',
  now = Date.now()
}) {
  validateOverrideTag(overrideTag)
  const runGit = async (args, allowedCodes = [0]) => {
    const result = await git(args)
    if (!allowedCodes.includes(result.exitCode)) {
      throw new Error(
        `git ${args[0]} failed (${result.exitCode}): ${result.stderr || result.stdout}`
      )
    }
    return result
  }
  const ancestor = async (older, newer) =>
    (await runGit(['merge-base', '--is-ancestor', older, newer], [0, 1])).exitCode === 0
  const restorePhorcaPolicy = async (source) => {
    await runGit(['rm', '-r', '-f', '--ignore-unmatch', '--', '.github/workflows'])
    if (
      (await runGit(['ls-tree', '--name-only', source, '--', '.github/workflows'])).stdout.trim()
    ) {
      await runGit([
        'restore',
        '--source',
        source,
        '--staged',
        '--worktree',
        '--',
        '.github/workflows'
      ])
    }
    await runGit(['rm', '-f', '--ignore-unmatch', '--', ...RETIRED_TESTS])
  }

  const pulls = await github.paginate(github.rest.pulls.list, {
    ...repo,
    head: `${repo.owner}:${ORCA_SYNC_BRANCH}`,
    state: 'all',
    sort: 'created',
    direction: 'desc',
    per_page: 100
  })
  const openPulls = pulls.filter((pull) => pull.state === 'open')
  if (openPulls.length > 1) {
    throw new Error('More than one Orca sync PR is open; close the duplicates.')
  }
  const pull = openPulls[0] ?? pulls[0]
  if (!manual && pull?.state === 'closed' && !pull.merged_at) {
    return `Updates paused because ${pull.html_url} was closed without merging. Run manually to resume.`
  }

  let releases
  if (overrideTag) {
    try {
      releases = [(await github.rest.repos.getReleaseByTag({ ...UPSTREAM, tag: overrideTag })).data]
    } catch (error) {
      if (error?.status === 404) {
        throw new Error(`No published stable desktop release exists for ${overrideTag}.`, {
          cause: error
        })
      }
      throw new Error(`Looking up Orca ${overrideTag} failed: ${error?.message ?? error}`, {
        cause: error
      })
    }
  } else {
    releases = await github.paginate(github.rest.repos.listReleases, { ...UPSTREAM, per_page: 100 })
  }
  const release = selectOrcaRelease(releases, { now, overrideTag })
  if (!release && (!pull || pull.merged_at)) {
    return 'No stable desktop Orca release is at least 72 hours old.'
  }

  const generatedBodyParts = pull?.body?.split(BODY_START)[1]?.split(BODY_END) ?? []
  const generatedBody = generatedBodyParts[0] ?? ''
  const describedTag =
    /\[Orca ([^\]]+)\]/.exec(generatedBody)?.[1] ??
    /Update Phorca to Orca (\S+)/.exec(pull?.title ?? '')?.[1] ??
    ''
  const describedVersion = parseDesktopStableTag(describedTag)
  const keepNewerRelease =
    release &&
    !pull?.merged_at &&
    describedVersion &&
    compareDesktopVersions(parseDesktopStableTag(release.tag_name), describedVersion) < 0
  if (keepNewerRelease && generatedBodyParts.length < 2) {
    throw new Error(
      `Restore the PR's release markers by running manually with tag ${describedTag}.`
    )
  }

  if ((await runGit(['status', '--porcelain'])).stdout.trim()) {
    throw new Error('Orca sync requires a clean, disposable workflow checkout.')
  }
  let releaseSha = ''
  if (release) {
    await runGit([
      'fetch',
      '--no-tags',
      UPSTREAM_URL,
      `+refs/tags/${release.tag_name}:${RELEASE_REF}`
    ])
    releaseSha = (await runGit(['rev-parse', `${RELEASE_REF}^{commit}`])).stdout.trim()
  }
  const baseRef = `refs/remotes/origin/${base}`
  const alreadyInBase = Boolean(release) && (await ancestor(releaseSha, baseRef))

  const remoteRef = `refs/heads/${ORCA_SYNC_BRANCH}`
  const remote = await runGit(['ls-remote', '--exit-code', '--heads', 'origin', remoteRef], [0, 2])
  const expectedHead = remote.stdout.trim().split(/\s+/)[0] ?? ''
  let preserveBranch = false
  if (expectedHead) {
    await runGit(['fetch', '--no-tags', 'origin', `+${remoteRef}:refs/remotes/orca-sync/previous`])
    // Only retire a branch whose entire history is already safely in Phorca.
    preserveBranch = !(await ancestor(expectedHead, baseRef))
  }
  if (!release && !preserveBranch) {
    return 'No stable desktop Orca release is at least 72 hours old.'
  }
  if (alreadyInBase && !preserveBranch) {
    return `Phorca already includes Orca ${release.tag_name}.`
  }
  if (keepNewerRelease && !preserveBranch) {
    throw new Error(
      `Restore the update branch for the PR's newer Orca ${describedTag} before syncing.`
    )
  }
  if (preserveBranch) {
    const workflowDiff = await runGit(
      ['diff', '--quiet', baseRef, expectedHead, '--', '.github/workflows'],
      [0, 1]
    )
    const workflowCommit = await runGit([
      'log',
      '-1',
      '--format=%s',
      expectedHead,
      '--',
      '.github/workflows'
    ])
    // Only the sync's own workflow snapshots can be replaced while a PR is under review.
    if (
      workflowDiff.exitCode !== 0 &&
      !/^AI-101 (Keep Phorca workflow files during Orca sync|Merge Orca \S+; keep Phorca workflows)$/.test(
        workflowCommit.stdout.trim()
      )
    ) {
      return 'Updates paused to preserve reviewed workflow changes on the update branch. Merge the PR before syncing again.'
    }
  }
  if (keepNewerRelease) {
    // Why: the PR metadata alone cannot prove a force-pushed branch still carries that release.
    await runGit([
      'fetch',
      '--no-tags',
      UPSTREAM_URL,
      `+refs/tags/${describedTag}:${DESCRIBED_REF}`
    ])
    if (!(await ancestor(`${DESCRIBED_REF}^{commit}`, expectedHead))) {
      throw new Error(
        `The update branch no longer contains the PR's Orca ${describedTag}. Run manually with tag ${describedTag} to restore it.`
      )
    }
  }

  await runGit(['config', 'user.name', 'github-actions[bot]'])
  await runGit(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
  let changed = Boolean(release)
  if (preserveBranch) {
    await runGit(['checkout', '-B', ORCA_SYNC_BRANCH, expectedHead])
    changed = Boolean(release) && !keepNewerRelease && !(await ancestor(releaseSha, 'HEAD'))
    if (changed) {
      await runGit(['merge', '--no-commit', '--no-ff', releaseSha], [0, 1])
      await restorePhorcaPolicy(baseRef)
      const conflicts = (await runGit(['diff', '--name-only', '--diff-filter=U'])).stdout.trim()
      if (conflicts) {
        await runGit(['merge', '--abort'])
        throw new Error(
          `Orca ${release.tag_name} conflicts with the update branch. Resolve manually; the remote branch was preserved.\n${conflicts}`
        )
      }
      await runGit(['rev-parse', '--verify', 'MERGE_HEAD'])
      await runGit(['commit', '-m', `AI-101 Merge Orca ${release.tag_name}; keep Phorca workflows`])
    }
  } else {
    // Starting at the upstream tag exposes conflicts in the PR without discarding fork changes.
    await runGit(['checkout', '-B', ORCA_SYNC_BRANCH, releaseSha])
  }

  await restorePhorcaPolicy(baseRef)
  const policyChanges = (await runGit(['diff', '--cached', '--quiet'], [0, 1])).exitCode !== 0
  if (policyChanges) {
    await runGit(['commit', '-m', 'AI-101 Keep Phorca workflow files during Orca sync'])
  }
  if (changed || policyChanges) {
    // GITHUB_TOKEN cannot push a tip whose workflow files differ from Phorca's default branch.
    await runGit(['diff', '--quiet', baseRef, 'HEAD', '--', '.github/workflows'])
    await runGit([
      'push',
      `--force-with-lease=${remoteRef}:${expectedHead}`,
      'origin',
      `HEAD:${remoteRef}`
    ])
  }

  const description = release ? releaseDescription(release, overrideTag) : pull.body
  const title = release ? `AI-101 Update Phorca to Orca ${release.tag_name}` : pull.title
  if (pull && !pull.merged_at) {
    const desiredTitle = keepNewerRelease ? pull.title : title
    const desiredBody =
      !release || keepNewerRelease ? pull.body : updatedDescription(pull.body, description)
    const needsUpdate =
      pull.state === 'closed' ||
      (pull.base?.ref ?? base) !== base ||
      pull.title !== desiredTitle ||
      pull.body !== desiredBody
    if (needsUpdate) {
      await github.rest.pulls.update({
        ...repo,
        pull_number: pull.number,
        state: 'open',
        base,
        title: desiredTitle,
        body: desiredBody
      })
    }
    const outcome = changed || policyChanges || needsUpdate ? 'Updated' : 'Kept'
    if (!release) {
      return `${outcome} ${pull.html_url}; no eligible Orca release, Phorca's workflow and retired-test policy is current.`
    }
    return `${outcome} ${pull.html_url}; the branch includes Orca ${keepNewerRelease ? describedTag : release.tag_name}.`
  }
  const created = await github.rest.pulls.create({
    ...repo,
    head: ORCA_SYNC_BRANCH,
    base,
    title,
    body: description,
    maintainer_can_modify: true
  })
  return `Created ${created.data.html_url} for Orca ${release.tag_name}.`
}

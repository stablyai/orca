#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isReleaseAppBot } from '../workflow-contracts/release-policy.mjs'
import { assertPolicyKeepsAppRelease } from './release-app-publish-guard.mjs'
import { verifyRequiredReleaseAssets } from './verify-release-required-assets.mjs'

const API_VERSION = '2022-11-28'
const DESKTOP_RC_TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$/
const FULL_SHA = /^[a-f0-9]{40}$/
const VERIFY_RELEASE_TAG = fileURLToPath(
  new URL('../operations/verify-release-tag.sh', import.meta.url)
)

// Why App only: any workflow with a write token can author a github-actions[bot] draft, so those are not trusted
// here; older github-actions[bot] drafts must be published by hand.
export function isReleaseCutDraft(release) {
  return (
    release?.draft === true &&
    isReleaseAppBot(release?.author) &&
    typeof release?.tag_name === 'string' &&
    DESKTOP_RC_TAG_PATTERN.test(release.tag_name)
  )
}

function isRcTag(tag) {
  return tag.includes('-rc.')
}

function gitOutput(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

export function isTagBuiltFromCurrentRef(tag, { cwd = process.cwd() } = {}) {
  try {
    const tagCommit = gitOutput(['rev-parse', `${tag}^{}`], cwd)
    const currentCommit = gitOutput(['rev-parse', 'HEAD'], cwd)
    if (tagCommit === currentCommit) {
      return true
    }

    return gitOutput(['rev-parse', `${tagCommit}^`], cwd) === currentCommit
  } catch {
    return false
  }
}

async function githubJson(fetchImpl, url, token, options = {}) {
  const res = await fetchImpl(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      ...options.headers
    }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub request failed ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

async function fetchReleases(repo, token, fetchImpl) {
  const releases = await githubJson(
    fetchImpl,
    `https://api.github.com/repos/${repo}/releases?per_page=100`,
    token
  )
  if (!Array.isArray(releases)) {
    throw new Error(`GitHub releases response for ${repo} was not an array`)
  }
  return releases
}

// Why: a draft's tag_name and target_commitish can be changed by anyone with contents write, so a leftover App
// draft can be re-pointed at a hand-pushed tag on a crafted commit. Before the App publishes it, the tag must pass
// the checks a recovered tag passes in cut (verify-release-tag.sh: annotated, pointing straight at the commit,
// exact message and tagger, a release commit that is the only child of its parent and changes only package.json's
// version, byte for byte), and that parent must be on main. Tagger and message are forgeable metadata; the content
// rule and main's history are what bind the published commit to reviewed code. Runs in the release source checkout
// (fetch-depth 0, so the remote tags and origin/main are local); executes only git, bash, sed, cmp and jq.
export function verifyDraftReleaseTag({
  tag,
  tagObjectSha,
  commitSha,
  cwd = process.cwd(),
  mainRef = 'refs/remotes/origin/main'
}) {
  const run = (program, args) =>
    execFileSync(program, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const attempt = (reason, program, args) => {
    try {
      return run(program, args)
    } catch {
      throw new Error(reason)
    }
  }
  if (!FULL_SHA.test(tagObjectSha ?? '')) {
    throw new Error('remote tag is not an annotated tag')
  }
  const local = attempt('remote tag is not in the release checkout', 'git', [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/tags/${tag}`
  ])
  if (local !== tagObjectSha) {
    throw new Error('release checkout has a different tag object than the remote')
  }
  const parents = attempt('draft commit is not in the release checkout', 'git', [
    'rev-list',
    '--parents',
    '-n',
    '1',
    commitSha
  ]).split(' ')
  if (parents.length !== 2 || parents[0] !== commitSha) {
    throw new Error('draft commit does not have exactly one parent')
  }
  const verified = attempt('tag is not one release-cut creates', 'bash', [
    VERIFY_RELEASE_TAG,
    `refs/tags/${tag}`,
    tag.slice(1),
    parents[1]
  ])
  if (verified !== commitSha) {
    throw new Error('tag is not one release-cut creates')
  }
  attempt('tag source is not on main', 'git', ['merge-base', '--is-ancestor', parents[1], mainRef])
}

// Why: the draft's target_commitish is the expected commit. create-draft-release sets it to the exact commit it
// verified the tag against, and every build checked out that commit. Drafts without a full-SHA target (older
// default-branch targets) cannot be verified and stay drafts.
async function assertDraftTagMatchesTarget(fetchImpl, repo, token, release, verifyDraftTag) {
  const tag = release.tag_name
  const expected = release.target_commitish
  if (!FULL_SHA.test(expected ?? '')) {
    throw new Error('draft does not record the commit it was built from')
  }
  const base = `https://api.github.com/repos/${repo}`
  const ref = await githubJson(fetchImpl, `${base}/git/ref/tags/${encodeURIComponent(tag)}`, token)
  let commit = ref?.ref === `refs/tags/${tag}` ? ref.object?.sha : undefined
  let tagObjectSha
  if (ref?.object?.type === 'tag') {
    // Peel the captured object ID, never the tag name again.
    const annotated = await githubJson(fetchImpl, `${base}/git/tags/${ref.object.sha}`, token)
    commit =
      annotated?.sha === ref.object.sha && annotated.object?.type === 'commit'
        ? annotated.object.sha
        : undefined
    tagObjectSha = commit ? ref.object.sha : undefined
  } else if (ref?.object?.type !== 'commit') {
    commit = undefined
  }
  if (commit !== expected) {
    throw new Error(`remote tag no longer resolves to draft commit ${expected}`)
  }
  await verifyDraftTag({ tag, tagObjectSha, commitSha: expected })
  await assertPolicyKeepsAppRelease({ repo, tag, commitSha: expected, token, fetchImpl })
}

// Why: a draft from an earlier run may be published only once its assets match the manifests that run's builds
// wrote. Until that check exists, refuse every draft; an operator verifies the assets and publishes by hand.
export async function refuseUnverifiedProvenance() {
  throw new Error(
    'asset provenance of drafts from earlier runs is not verified yet; publish by hand'
  )
}

export async function publishCompleteDraftReleases({
  repo,
  token,
  fetchImpl = fetch,
  verifyReleaseAssets = verifyRequiredReleaseAssets,
  verifyAssetProvenance = refuseUnverifiedProvenance,
  isDraftBuiltFromCurrentRef = ({ tag }) => isTagBuiltFromCurrentRef(tag),
  verifyDraftTag = verifyDraftReleaseTag,
  log = console.log
}) {
  if (!repo) {
    throw new Error('repo is required')
  }
  if (!token) {
    throw new Error('token is required')
  }

  const releases = await fetchReleases(repo, token, fetchImpl)
  const candidates = releases
    .filter(isReleaseCutDraft)
    .sort((a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime())

  const published = []
  const skipped = []

  for (const release of candidates) {
    const tag = release.tag_name
    if (!(await Promise.resolve(isDraftBuiltFromCurrentRef({ tag, release })))) {
      const reason = 'tag is not built from the current release ref'
      skipped.push({ tag, reason })
      log(`Skipping stale RC draft release ${tag}: ${reason}`)
      continue
    }

    try {
      await verifyReleaseAssets({ repo, tag, token })
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
      skipped.push({ tag, reason })
      log(`Skipping incomplete RC draft release ${tag}: ${reason}`)
      continue
    }

    try {
      await verifyAssetProvenance({ repo, token, release })
      await assertDraftTagMatchesTarget(fetchImpl, repo, token, release, verifyDraftTag)
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
      skipped.push({ tag, reason })
      log(`Skipping unverifiable RC draft release ${tag}: ${reason}`)
      continue
    }

    // Resume only release-cut RC drafts with complete assets; incomplete drafts stay private for normal rebuild.
    await githubJson(
      fetchImpl,
      `https://api.github.com/repos/${repo}/releases/${release.id}`,
      token,
      {
        method: 'PATCH',
        // tag_name on every PATCH: one without it reset the v1.4.259 draft to an untagged-… release.
        body: JSON.stringify({
          tag_name: tag,
          draft: false,
          prerelease: isRcTag(tag)
        })
      }
    )
    published.push(tag)
    log(`Published complete RC draft release ${tag}`)
  }

  if (published.length === 0 && skipped.length === 0) {
    log('No complete release-cut RC drafts to publish.')
  }

  return { published, skipped }
}

export function writeGithubOutputs({ published, skipped }, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) {
    return
  }
  appendFileSync(
    outputPath,
    `${[
      `published_count=${published.length}`,
      `skipped_count=${skipped.length}`,
      `latest_published_tag=${published.at(-1) ?? ''}`,
      `published_tags=${published.join(',')}`,
      `skipped_tags=${skipped.map((item) => item.tag).join(',')}`
    ].join('\n')}\n`
  )
}

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY || 'stablyai/orca'
  const result = await publishCompleteDraftReleases({ repo, token })
  writeGithubOutputs(result)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}

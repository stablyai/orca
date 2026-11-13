#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const API_VERSION = '2022-11-28'
export const MAX_RELEASE_BODY_LENGTH = 120_000
const TRUNCATION_NOTICE =
  '\n\n---\nRelease notes were truncated because GitHub release bodies are limited to 125,000 characters.'
const DESKTOP_RELEASE_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/

export function parseDesktopReleaseTag(tag) {
  const match = DESKTOP_RELEASE_TAG_PATTERN.exec(tag)
  if (!match) {
    return null
  }
  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rc: match[4] === undefined ? null : Number(match[4])
  }
}

function compareDesktopReleaseTags(a, b) {
  const versionDiff = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (versionDiff !== 0) {
    return versionDiff
  }
  if (a.rc === b.rc) {
    return 0
  }
  if (a.rc === null) {
    return 1
  }
  if (b.rc === null) {
    return -1
  }
  return a.rc - b.rc
}

export function latestPreviousPublishedDesktopReleaseTag(releases, tag) {
  const current = parseDesktopReleaseTag(tag)
  if (!current) {
    return ''
  }
  const previousReleases = releases
    .filter((release) => release?.draft === false && typeof release.tag_name === 'string')
    .map((release) => parseDesktopReleaseTag(release.tag_name))
    .filter((candidate) => candidate && candidate.tag !== current.tag)
    .filter((candidate) => compareDesktopReleaseTags(candidate, current) < 0)
    // Bound notes by public releases; stable summarizes since prior stable, not the latest RC.
    .filter((candidate) => current.rc !== null || candidate.rc === null)
    .sort(compareDesktopReleaseTags)
  return previousReleases.at(-1)?.tag ?? ''
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION
  }
}

async function githubJson(fetchImpl, url, token, options = {}) {
  const res = await fetchImpl(url, {
    ...options,
    headers: {
      ...githubHeaders(token),
      ...options.headers
    }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub request failed ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

async function fetchRepoReleases(repo, token, fetchImpl) {
  const releases = []
  for (let page = 1; ; page += 1) {
    const pageReleases = await githubJson(
      fetchImpl,
      `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
      token
    )
    if (!Array.isArray(pageReleases)) {
      throw new Error(`GitHub releases response page ${page} for ${repo} was not an array`)
    }
    releases.push(...pageReleases)
    if (pageReleases.length < 100) {
      break
    }
  }
  return releases
}

export function truncateReleaseBody(body, maxLength = MAX_RELEASE_BODY_LENGTH) {
  if (body.length <= maxLength) {
    return body
  }

  const availableLength = maxLength - TRUNCATION_NOTICE.length
  if (availableLength <= 0) {
    throw new Error('Release truncation notice is longer than the maximum release body length')
  }

  return `${body.slice(0, availableLength).trimEnd()}${TRUNCATION_NOTICE}`
}

async function verifyReleaseSource({ repo, tag, token, targetCommitish, sourceSha, fetchImpl }) {
  const base = `https://api.github.com/repos/${repo}`
  const ref = await githubJson(fetchImpl, `${base}/git/ref/tags/${encodeURIComponent(tag)}`, token)
  if (ref?.ref !== `refs/tags/${tag}` || !ref.object?.sha) {
    throw new Error(`Missing exact remote tag ${tag}`)
  }
  const commit = await githubJson(
    fetchImpl,
    `${base}/commits/refs/tags/${encodeURIComponent(tag)}`,
    token
  )
  if (
    commit?.sha !== targetCommitish ||
    (commit.sha !== sourceSha &&
      !(commit.parents?.length === 1 && commit.parents[0].sha === sourceSha))
  ) {
    throw new Error(`Remote tag ${tag} does not match the approved release source and checkout`)
  }
  return ref.object.sha
}

async function verifyUploaderDraft({ repo, tag, token, release, fetchImpl, sleep }) {
  if (!Number.isInteger(release?.id) || release.draft !== true || release.tag_name !== tag) {
    throw new Error(`Expected an exact-tag draft for ${tag}`)
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Match the publisher's default first page and first prefixed-or-bare-version match.
    const page = await githubJson(fetchImpl, `https://api.github.com/repos/${repo}/releases`, token)
    if (!Array.isArray(page)) {
      throw new Error('GitHub releases response was not an array')
    }
    const selected = page.find((item) => item?.tag_name === tag || item?.tag_name === tag.slice(1))
    if (selected) {
      if (selected.id !== release.id || selected.tag_name !== tag || selected.draft !== true) {
        throw new Error(`Uploader would not select the prepared draft ${tag}`)
      }
      return
    }
    if (attempt < 2) {
      await sleep(1000)
    }
  }
  throw new Error(`Prepared draft ${tag} is not visible to the uploader`)
}

export async function createDraftRelease({
  repo,
  tag,
  token,
  targetCommitish,
  sourceSha,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetchImpl = fetch,
  log = console.log
}) {
  if (!repo) {
    throw new Error('repo is required')
  }
  if (!tag) {
    throw new Error('tag is required')
  }
  if (!token) {
    throw new Error('token is required')
  }
  if (!targetCommitish) {
    throw new Error('targetCommitish is required')
  }

  const releases = await fetchRepoReleases(repo, token, fetchImpl)
  const existingRelease = releases.find((release) => release?.tag_name === tag)
  if (existingRelease && existingRelease.draft !== true) {
    log(`Release ${tag} already exists and is published.`)
    return
  }

  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '') || !/^[a-f0-9]{40}$/.test(targetCommitish)) {
    throw new Error('Approved source and checkout must be full commit SHAs')
  }
  const identity = { repo, tag, token, targetCommitish, sourceSha, fetchImpl }
  const originalTagObject = await verifyReleaseSource(identity)
  const repository = await githubJson(fetchImpl, `https://api.github.com/repos/${repo}`, token)
  if (typeof repository.default_branch !== 'string' || !repository.default_branch) {
    throw new Error('Repository default branch is missing')
  }
  const targetMetadata = repository.default_branch
  let preparedRelease

  const previousTag = latestPreviousPublishedDesktopReleaseTag(releases, tag)
  const generateNotesBody = {
    tag_name: tag,
    target_commitish: tag,
    ...(previousTag ? { previous_tag_name: previousTag } : {})
  }

  // generate-notes ignores drafts; pass previous public changelog boundary explicitly.
  const releaseNotes = await githubJson(
    fetchImpl,
    `https://api.github.com/repos/${repo}/releases/generate-notes`,
    token,
    {
      method: 'POST',
      body: JSON.stringify(generateNotesBody)
    }
  )

  const generatedBody = typeof releaseNotes.body === 'string' ? releaseNotes.body : ''
  const body = truncateReleaseBody(generatedBody)
  const name =
    typeof releaseNotes.name === 'string' && releaseNotes.name.length > 0 ? releaseNotes.name : tag
  const prerelease = tag.includes('-rc.')

  if (existingRelease) {
    if (!Number.isInteger(existingRelease.id)) {
      throw new Error(`Draft release ${tag} is missing a GitHub release id`)
    }
    // Draft may publish while notes generate; recheck before overwriting a live body.
    const currentRelease = await githubJson(
      fetchImpl,
      `https://api.github.com/repos/${repo}/releases/${existingRelease.id}`,
      token
    )
    if (currentRelease?.draft !== true) {
      throw new Error(
        `Release ${tag} was published while notes were generated; leaving it unchanged.`
      )
    }
    if (currentRelease.tag_name !== tag || currentRelease.id !== existingRelease.id) {
      throw new Error(`Draft identity changed for ${tag}`)
    }
    if ((await verifyReleaseSource(identity)) !== originalTagObject) {
      throw new Error(`Remote tag ${tag} changed during draft preparation`)
    }
    // PATCH has no conditional/version guard; if publication wins the GET/PATCH race, restore the published body.
    const patchedRelease = await githubJson(
      fetchImpl,
      `https://api.github.com/repos/${repo}/releases/${existingRelease.id}`,
      token,
      {
        method: 'PATCH',
        body: JSON.stringify({ body, target_commitish: targetMetadata })
      }
    )
    if (patchedRelease?.draft !== true) {
      const publishedBody = typeof currentRelease.body === 'string' ? currentRelease.body : ''
      if (publishedBody === body) {
        throw new Error(
          `Release ${tag} was published while notes were patched; its body is unchanged.`
        )
      }
      // Rollback only our exact body or it can clobber a newer edit.
      const releaseBeforeRollback = await githubJson(
        fetchImpl,
        `https://api.github.com/repos/${repo}/releases/${existingRelease.id}`,
        token
      )
      if (releaseBeforeRollback?.body !== body) {
        throw new Error(
          `Release ${tag} was published and its body changed again while notes were patched; leaving the newer body in place.`
        )
      }
      await githubJson(
        fetchImpl,
        `https://api.github.com/repos/${repo}/releases/${existingRelease.id}`,
        token,
        {
          method: 'PATCH',
          body: JSON.stringify({ body: publishedBody })
        }
      )
      throw new Error(
        `Release ${tag} was published while notes were patched; restored its published body and left the generated notes unapplied.`
      )
    }
    preparedRelease = patchedRelease
  } else {
    if ((await verifyReleaseSource(identity)) !== originalTagObject) {
      throw new Error(`Remote tag ${tag} changed during draft preparation`)
    }
    // The existing verified tag owns source identity; default-branch metadata avoids workflow-write authorization.
    const createdRelease = await githubJson(
      fetchImpl,
      `https://api.github.com/repos/${repo}/releases`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: targetMetadata,
          name,
          body,
          draft: true,
          prerelease,
          make_latest: 'false'
        })
      }
    )
    preparedRelease = createdRelease
  }

  await verifyUploaderDraft({ repo, tag, token, release: preparedRelease, fetchImpl, sleep })
  if ((await verifyReleaseSource(identity)) !== originalTagObject) {
    throw new Error(`Remote tag ${tag} changed after draft preparation`)
  }

  if (generatedBody.length !== body.length) {
    log(
      `${existingRelease ? 'Updated' : 'Created'} draft release ${tag} with truncated generated notes (${body.length} chars).`
    )
  } else {
    log(
      `${existingRelease ? 'Updated' : 'Created'} draft release ${tag} with generated notes (${body.length} chars).`
    )
  }
}

async function main() {
  const tag = process.argv[2]
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY || 'stablyai/orca'
  const targetCommitish = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  await createDraftRelease({ repo, tag, token, targetCommitish, sourceSha: process.env.SOURCE_SHA })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}

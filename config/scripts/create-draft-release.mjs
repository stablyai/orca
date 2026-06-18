#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const API_VERSION = '2022-11-28'
const MAX_RELEASE_BODY_LENGTH = 120_000
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

export function latestPreviousDesktopReleaseTag(tags, tag) {
  const current = parseDesktopReleaseTag(tag)
  if (!current) {
    return ''
  }
  const previousTags = tags
    .map((candidate) => parseDesktopReleaseTag(candidate))
    .filter((candidate) => candidate && candidate.tag !== current.tag)
    .filter((candidate) => compareDesktopReleaseTags(candidate, current) < 0)
    .sort(compareDesktopReleaseTags)
  return previousTags.at(-1)?.tag ?? ''
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

async function fetchRepoTags(repo, token, fetchImpl) {
  const tags = []
  for (let page = 1; ; page += 1) {
    const pageTags = await githubJson(
      fetchImpl,
      `https://api.github.com/repos/${repo}/tags?per_page=100&page=${page}`,
      token
    )
    if (!Array.isArray(pageTags)) {
      throw new Error(`GitHub tags response page ${page} for ${repo} was not an array`)
    }
    for (const tag of pageTags) {
      if (typeof tag?.name === 'string') {
        tags.push(tag.name)
      }
    }
    if (pageTags.length < 100) {
      break
    }
  }
  return tags
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

export async function createDraftRelease({
  repo,
  tag,
  token,
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

  const previousTag = latestPreviousDesktopReleaseTag(
    await fetchRepoTags(repo, token, fetchImpl),
    tag
  )
  const generateNotesBody = {
    tag_name: tag,
    target_commitish: tag,
    ...(previousTag ? { previous_tag_name: previousTag } : {})
  }

  // Why: draft releases are invisible to GitHub's generate-notes baseline.
  // Passing the previous desktop tag keeps each release from accumulating
  // notes from older drafts.
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

  // Why: GitHub's generated release notes can exceed the release body API
  // limit, so create with a bounded body. Omit target_commitish because the
  // release-cut tag already exists and GitHub rejects the tag name there.
  await githubJson(fetchImpl, `https://api.github.com/repos/${repo}/releases`, token, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: tag,
      name,
      body,
      draft: true,
      prerelease
    })
  })

  if (generatedBody.length !== body.length) {
    log(`Created draft release ${tag} with truncated generated notes (${body.length} chars).`)
  } else {
    log(`Created draft release ${tag} with generated notes (${body.length} chars).`)
  }
}

async function main() {
  const tag = process.argv[2]
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY || 'stablyai/orca'
  await createDraftRelease({ repo, tag, token })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}

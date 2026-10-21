#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const API_VERSION = '2022-11-28'

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

export function matchingDesktopReleases(releases, tag) {
  const version = tag.startsWith('v') ? tag.slice(1) : tag
  return (releases ?? []).filter((release) => {
    const tagName = release?.tag_name
    const name = release?.name
    return tagName === tag || tagName === version || name === tag || name === version
  })
}

export async function restorePublishedDesktopReleasesToDraft({
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

  const releases = await githubJson(
    fetchImpl,
    `https://api.github.com/repos/${repo}/releases?per_page=100`,
    token
  )
  if (!Array.isArray(releases)) {
    throw new Error(`GitHub releases response for ${repo} was not an array`)
  }

  const matches = matchingDesktopReleases(releases, tag)
  if (matches.length === 0) {
    throw new Error(`No GitHub release named ${tag} was found after artifact upload`)
  }

  const restored = []
  for (const release of matches) {
    if (release?.draft === true) {
      continue
    }
    if (!Number.isInteger(release.id)) {
      throw new Error(`Release ${tag} is missing a GitHub release id`)
    }
    const patched = await githubJson(
      fetchImpl,
      `https://api.github.com/repos/${repo}/releases/${release.id}`,
      token,
      {
        method: 'PATCH',
        body: JSON.stringify({ draft: true, make_latest: 'false' })
      }
    )
    log(`Restored GitHub release ${release.id} (${release.tag_name}) to draft.`)
    restored.push(patched)
  }
  return restored
}

async function main() {
  // Why env TAG: the Windows release-cut matrix uses pwsh, which does not
  // expand bash-style "$TAG" in argv. The step still exports TAG.
  const tag = process.argv[2] || process.env.TAG
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY || 'stablyai/orca'
  const restored = await restorePublishedDesktopReleasesToDraft({
    repo,
    tag,
    token,
    log: (message) => console.error(message)
  })
  if (restored.length > 0) {
    console.error(
      `::error::Release ${tag} was published during artifact upload. Restored ${restored.length} release(s) to draft so /releases/latest does not serve partial assets.`
    )
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}

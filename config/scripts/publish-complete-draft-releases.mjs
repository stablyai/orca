#!/usr/bin/env node

import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { verifyRequiredReleaseAssets } from './verify-release-required-assets.mjs'

const API_VERSION = '2022-11-28'
const RELEASE_CUT_AUTHOR = 'github-actions[bot]'
const DESKTOP_RC_TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$/

export function isReleaseCutDraft(release) {
  return (
    release?.draft === true &&
    release?.author?.login === RELEASE_CUT_AUTHOR &&
    typeof release?.tag_name === 'string' &&
    DESKTOP_RC_TAG_PATTERN.test(release.tag_name)
  )
}

function isRcTag(tag) {
  return tag.includes('-rc.')
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

export async function publishCompleteDraftReleases({
  repo,
  token,
  fetchImpl = fetch,
  verifyReleaseAssets = verifyRequiredReleaseAssets,
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
    try {
      await verifyReleaseAssets({ repo, tag, token })
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
      skipped.push({ tag, reason })
      log(`Skipping incomplete RC draft release ${tag}: ${reason}`)
      continue
    }

    // Why: only release-cut-authored RC drafts with a complete asset set are
    // resumed here; incomplete drafts stay private for the normal rebuild path.
    await githubJson(fetchImpl, `https://api.github.com/repos/${repo}/releases/${release.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({
        draft: false,
        prerelease: isRcTag(tag)
      })
    })
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

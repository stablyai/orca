#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const API_VERSION = '2022-11-28'
const MAX_RELEASE_BODY_LENGTH = 120_000
const TRUNCATION_NOTICE =
  '\n\n---\nRelease notes were truncated because GitHub release bodies are limited to 125,000 characters.'

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

  const releaseNotes = await githubJson(
    fetchImpl,
    `https://api.github.com/repos/${repo}/releases/generate-notes`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: tag
      })
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

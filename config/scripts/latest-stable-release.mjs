#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const API_VERSION = '2022-11-28'
const DESKTOP_STABLE_TAG_PATTERN = /^v([0-9]+)\.([0-9]+)\.([0-9]+)$/

export function parseDesktopStableTag(tag) {
  const match = DESKTOP_STABLE_TAG_PATTERN.exec(tag)
  if (!match) {
    return null
  }

  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  }
}

export function latestStableDesktopReleaseTag(releases) {
  const stableTags = releases
    .filter((release) => release?.draft !== true)
    .map((release) => parseDesktopStableTag(release?.tag_name ?? release?.tagName ?? ''))
    .filter(Boolean)
    .sort((a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch)

  return stableTags.at(-1)?.tag ?? ''
}

async function githubJson(fetchImpl, url, token) {
  const res = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION
    }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub request failed ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

export async function fetchReleases(repo, token, fetchImpl = fetch) {
  if (!repo) {
    throw new Error('repo is required')
  }
  if (!token) {
    throw new Error('token is required')
  }

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

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY || 'stablyai/orca'
  const releases = await fetchReleases(repo, token)
  process.stdout.write(latestStableDesktopReleaseTag(releases))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

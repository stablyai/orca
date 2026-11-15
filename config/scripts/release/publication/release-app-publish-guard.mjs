#!/usr/bin/env node
// Release Policy runs from the tagged commit. A commit older than the App-aware policy deletes a release the
// App published unless the release pipeline made its tag, so the App must never draft or publish one of those.
// This only prevents that accidental deletion. Tagger and commit subject are unauthenticated metadata anyone who
// can push a tag can set, so this is not a trust boundary; the tag ruleset is.

import { pathToFileURL } from 'node:url'

const API_VERSION = '2022-11-28'
const PIPELINE_TAGGER_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'
const POLICY_WORKFLOW = '.github/workflows/release-policy.yml'
// Present only in policy workflows that pass the App's bot ID to release-policy.mjs.
const APP_AWARE_MARKER = 'RELEASE_APP_BOT_ID'

async function githubGet(fetchImpl, url, token) {
  const res = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION
    }
  })
  if (res.status === 404) {
    return null
  }
  if (!res.ok) {
    throw new Error(`GitHub request failed ${res.status}: ${url}`)
  }
  return res.json()
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function assertPolicyKeepsAppRelease({
  repo,
  tag,
  commitSha,
  token,
  fetchImpl = fetch
}) {
  const base = `https://api.github.com/repos/${repo}`
  const policy = await githubGet(
    fetchImpl,
    `${base}/contents/${POLICY_WORKFLOW}?ref=${encodeURIComponent(commitSha)}`,
    token
  )
  if (
    Buffer.from(policy?.content ?? '', 'base64')
      .toString('utf8')
      .includes(APP_AWARE_MARKER)
  ) {
    return
  }
  // The older policy still keeps a release whose annotated tag the pipeline made on a release commit.
  const ref = await githubGet(fetchImpl, `${base}/git/ref/tags/${encodeURIComponent(tag)}`, token)
  if (ref?.object?.type === 'tag') {
    const tagObject = await githubGet(fetchImpl, `${base}/git/tags/${ref.object.sha}`, token)
    const commit = await githubGet(fetchImpl, `${base}/git/commits/${commitSha}`, token)
    const subject = String(commit?.message ?? '').split('\n')[0]
    if (
      tagObject?.tagger?.email === PIPELINE_TAGGER_EMAIL &&
      tagObject.object?.type === 'commit' &&
      tagObject.object.sha === commitSha &&
      new RegExp(`^release: ${escapeRegExp(tag)}(?: \\[rc-slot:[^\\]]+\\])?$`).test(subject)
    ) {
      return
    }
  }
  throw new Error(
    `Release ${tag} (${commitSha}) has a Release Policy older than the release App and a tag the pipeline did not make; that policy would delete it if the App published it. Publish ${tag} by hand.`
  )
}

async function main() {
  const [tag, commitSha] = process.argv.slice(2)
  await assertPolicyKeepsAppRelease({
    repo: process.env.GITHUB_REPOSITORY,
    tag,
    commitSha,
    token: process.env.GH_TOKEN
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`::error::${error.message}`)
    process.exit(1)
  })
}

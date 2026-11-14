// Enforced by .github/workflows/release-policy.yml on release events.

import {
  DESKTOP_RC_TAG as RC_TAG,
  DESKTOP_STABLE_TAG as STABLE_TAG,
  MOBILE_TAG,
  isAgentStateRulesTag
} from '../versioning/release-tag-patterns.mjs'

const BOT_LOGIN = 'github-actions[bot]'
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'
const RELEASE_APP_BOT_LOGIN = 'orca-release[bot]'

// Why: release-cut drafts and publishes with the release GitHub App, whose releases (unlike GITHUB_TOKEN's)
// emit release events. Match its bot by repo variable RELEASE_APP_BOT_ID (its user ID, stable across App
// renames) or by its login, which only that App can hold.
export function isReleaseAppBot(author, botId = process.env.RELEASE_APP_BOT_ID) {
  const id = botId?.trim()
  return (
    author?.type === 'Bot' &&
    (author.login === RELEASE_APP_BOT_LOGIN || (Boolean(id) && String(author.id) === id))
  )
}

// Bot-authored agent-state prereleases need separate policy because updater follows Latest, which prereleases cannot become.
export function isPrereleaseTag(tag) {
  return RC_TAG.test(tag) || MOBILE_TAG.test(tag) || isAgentStateRulesTag(tag)
}

export function compareStableTags(left, right) {
  const a = left.slice(1).split('.').map(Number)
  const b = right.slice(1).split('.').map(Number)
  return a.reduce((result, part, index) => result || part - b[index], 0)
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Authorize Cut Release via annotated tag/release commit: draft’s original creator may remain a person.
export async function isCutByReleasePipeline(github, { owner, repo }, tag) {
  if (!STABLE_TAG.test(tag) && !RC_TAG.test(tag)) {
    return false
  }
  let ref
  try {
    ;({ data: ref } = await github.rest.git.getRef({ owner, repo, ref: `tags/${tag}` }))
  } catch (error) {
    if (error.status === 404) {
      return false
    }
    throw error
  }
  if (ref.object.type !== 'tag') {
    return false
  }
  const { data: tagObject } = await github.rest.git.getTag({
    owner,
    repo,
    tag_sha: ref.object.sha
  })
  if (tagObject.tagger?.email !== BOT_EMAIL || tagObject.object.type !== 'commit') {
    return false
  }
  const { data: commit } = await github.rest.git.getCommit({
    owner,
    repo,
    commit_sha: tagObject.object.sha
  })
  const subject = commit.message.split('\n')[0]
  return new RegExp(`^release: ${escapeRegExp(tag)}(?: \\[rc-slot:[^\\]]+\\])?$`).test(subject)
}

async function isAuthorizedRelease(github, repoRef, release) {
  const tag = release.tag_name
  if (!STABLE_TAG.test(tag) && !isPrereleaseTag(tag)) {
    return false
  }
  return (
    release.author?.login === BOT_LOGIN ||
    isReleaseAppBot(release.author) ||
    isCutByReleasePipeline(github, repoRef, tag)
  )
}

// Force highest authorized stable release to Latest; GitHub’s choice/old bot filter can select an older version.
// Why skip and report: App-published releases emit events, so this runs after every publish. Skip the PATCH
// when GitHub already shows the right Latest, and report a failed PATCH instead of throwing: it changes
// nothing else and must never stop the rest of the policy.
export async function restoreLatestStable(github, repoRef, core) {
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...repoRef,
    per_page: 100
  })
  const candidates = releases
    .filter((release) => !release.draft && !release.prerelease && STABLE_TAG.test(release.tag_name))
    .sort((left, right) => compareStableTags(right.tag_name, left.tag_name))
  for (const release of candidates) {
    if (!(await isAuthorizedRelease(github, repoRef, release))) {
      continue
    }
    const latest = await github.rest.repos.getLatestRelease(repoRef).catch(() => null)
    if (latest?.data?.id === release.id) {
      return release.tag_name
    }
    try {
      await github.rest.repos.updateRelease({
        ...repoRef,
        release_id: release.id,
        tag_name: release.tag_name,
        make_latest: 'true'
      })
    } catch (error) {
      core?.error(
        `Could not mark ${release.tag_name} as the Latest release (${error.status ?? error.message}); set it by hand on the release page.`
      )
      return null
    }
    return release.tag_name
  }
  return null
}

export async function enforceReleasePolicy({ github, context, core }) {
  const { release, action } = context.payload
  const tag = release.tag_name
  const author = release.author?.login
  const repoRef = context.repo
  const expectedPrerelease = isPrereleaseTag(tag)

  if (await isAuthorizedRelease(github, repoRef, release)) {
    if (release.prerelease !== expectedPrerelease) {
      await github.rest.repos.updateRelease({
        ...repoRef,
        release_id: release.id,
        tag_name: tag,
        prerelease: expectedPrerelease,
        make_latest: expectedPrerelease ? 'false' : 'legacy'
      })
    }
    await restoreLatestStable(github, repoRef, core)
    return
  }

  // Notes edits are not publication; deleting on edit removed v1.4.216 and its tag.
  if (action !== 'published') {
    core.warning(
      `Release ${tag} by ${author || 'unknown'} is outside release policy; left as-is on "${action}".`
    )
    return
  }

  await github.rest.repos.updateRelease({
    ...repoRef,
    release_id: release.id,
    tag_name: tag,
    draft: true,
    prerelease: true,
    make_latest: 'false'
  })
  await restoreLatestStable(github, repoRef, core)
  await github.rest.repos.deleteRelease({ ...repoRef, release_id: release.id })
  try {
    await github.rest.git.deleteRef({ ...repoRef, ref: `tags/${tag}` })
  } catch (error) {
    if (error.status !== 404) {
      throw error
    }
  }
  core.warning(`Deleted unauthorized release ${tag} created by ${author || 'unknown'}.`)
}

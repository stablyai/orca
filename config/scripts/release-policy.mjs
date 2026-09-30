// Enforced by .github/workflows/release-policy.yml on release events.

const BOT_LOGIN = 'github-actions[bot]'
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'
const NUMBER = '(?:0|[1-9][0-9]*)'
const VERSION = `${NUMBER}\\.${NUMBER}\\.${NUMBER}`
const STABLE_TAG = new RegExp(`^v${VERSION}$`)
const RC_TAG = new RegExp(`^v${VERSION}-rc\\.${NUMBER}(?:\\.[0-9A-Za-z]+)?$`)
const MOBILE_TAG = new RegExp(`^mobile(?:-android)?-v${VERSION}$`)

export function isPrereleaseTag(tag) {
  return RC_TAG.test(tag) || MOBILE_TAG.test(tag)
}

export function compareStableTags(left, right) {
  const a = left.slice(1).split('.').map(Number)
  const b = right.slice(1).split('.').map(Number)
  return a.reduce((result, part, index) => result || part - b[index], 0)
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Why: Cut Release creates the annotated tag and its `release: vX` commit, but the
// release object keeps whoever created the draft first, which can be a person.
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
  return release.author?.login === BOT_LOGIN || isCutByReleasePipeline(github, repoRef, tag)
}

// Why: the highest authorized stable release must be Latest; GitHub's own pick
// (and the old bot-author-only filter) can move it to an older version.
export async function restoreLatestStable(github, repoRef) {
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
    await github.rest.repos.updateRelease({
      ...repoRef,
      release_id: release.id,
      make_latest: 'true'
    })
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
        prerelease: expectedPrerelease,
        make_latest: expectedPrerelease ? 'false' : 'legacy'
      })
    }
    await restoreLatestStable(github, repoRef)
    return
  }

  // Why: editing notes on a live release is not a publication; deleting on edit
  // took down the v1.4.216 release and its tag.
  if (action !== 'published') {
    core.warning(
      `Release ${tag} by ${author || 'unknown'} is outside release policy; left as-is on "${action}".`
    )
    return
  }

  await github.rest.repos.updateRelease({
    ...repoRef,
    release_id: release.id,
    draft: true,
    prerelease: true,
    make_latest: 'false'
  })
  await restoreLatestStable(github, repoRef)
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

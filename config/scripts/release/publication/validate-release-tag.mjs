import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'

const TAG_PATTERN =
  /^v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z]*[A-Za-z][0-9A-Za-z]*))?)?$/
const CANDIDATE = 'refs/release-cut/candidate'

function git(args, cwd, raw = false) {
  const output = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return raw ? output : output.trim()
}

function requireTag(tag) {
  if (!TAG_PATTERN.test(tag)) {
    throw new Error('Invalid desktop release tag')
  }
}

export function validateReleaseTag({
  sourceSha,
  tag,
  bundle,
  recovery = false,
  version = '',
  suffix = '',
  kind = 'rc',
  cwd = process.cwd()
}) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error('Expected an independently pinned source SHA')
  }
  requireTag(tag)
  if (bundle) {
    git(['bundle', 'verify', bundle], cwd)
    git(['fetch', '--no-tags', bundle, `refs/tags/${tag}:${CANDIDATE}`], cwd)
  } else {
    git(['fetch', '--no-tags', '--depth=2', 'origin', `refs/tags/${tag}:${CANDIDATE}`], cwd)
  }
  const object = git(['rev-parse', CANDIDATE], cwd)
  const sha = git(['rev-parse', `${CANDIDATE}^{commit}`], cwd)
  const parents = git(['show', '-s', '--format=%P', sha], cwd).split(' ')
  if (recovery) {
    if (sha !== sourceSha && parents[0] !== sourceSha) {
      throw new Error('Recovered tag is from another source')
    }
  } else {
    if (parents.length !== 1 || parents[0] !== sourceSha) {
      throw new Error('Release commit is from another source')
    }
    const paths = git(
      ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sourceSha, sha],
      cwd,
      true
    )
      .split('\0')
      .filter(Boolean)
    if (paths.some((path) => path !== 'package.json')) {
      throw new Error('Release commit changes more than package.json')
    }
    const entries = [sourceSha, sha].map((commit) =>
      git(['ls-tree', commit, '--', 'package.json'], cwd)
    )
    for (const entry of entries) {
      if (
        !/^100(?:644|755) blob [0-9a-f]{40}\tpackage.json$/.test(entry) ||
        entry.slice(0, 6) !== entries[0].slice(0, 6)
      ) {
        throw new Error('package.json must be a regular file with unchanged mode')
      }
    }
    const before = JSON.parse(git(['show', `${sourceSha}:package.json`], cwd))
    const after = JSON.parse(git(['show', `${sha}:package.json`], cwd))
    if (
      !before ||
      typeof before !== 'object' ||
      Array.isArray(before) ||
      !isDeepStrictEqual({ ...before, version: tag.slice(1) }, after)
    ) {
      throw new Error('Release package changes more than its version')
    }
    const annotation = git(['cat-file', 'tag', object], cwd).split('\n\n')[0]
    if (!annotation.startsWith(`object ${sha}\ntype commit\ntag ${tag}\n`)) {
      throw new Error('Release tag must directly annotate the version commit')
    }
    const explicitVersion = version.replace(/^v/, '')
    if (version && tag !== `v${explicitVersion}${suffix ? `.${suffix}` : ''}`) {
      throw new Error('Tag does not match the requested version')
    }
    if (!version && (kind === 'rc') !== tag.includes('-rc.')) {
      throw new Error('Tag does not match the requested release kind')
    }
    if (!version && kind === 'rc' && suffix && !tag.endsWith(`.${suffix}`)) {
      throw new Error('Tag does not match the requested suffix')
    }
  }
  const ships = [
    'config/scripts/orcad-distribution/template/packaged-orcad-template.cjs',
    'config/scripts/packaged-orcad-template.cjs'
  ].some((path) => {
    try {
      git(['cat-file', '-e', `${sha}:${path}`], cwd)
      return true
    } catch {
      return false
    }
  })
  return { tag, release_sha: sha, tag_object_sha: object, ships_orcad_template: String(ships) }
}

async function releaseState(tag) {
  const response = await fetch(
    `https://api.github.com/repos/stablyai/orca/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json'
      }
    }
  )
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`Cannot verify release state: HTTP ${response.status}`)
  }
  return response.json()
}

async function main() {
  const env = process.env
  const output = {
    tag: '',
    release_sha: '',
    tag_object_sha: '',
    should_release: 'false',
    ships_orcad_template: 'false',
    latest_published_rc_tag: ''
  }
  if (env.DRY_RUN !== 'true') {
    if (env.NEW_TAG && env.RECOVERED_TAG) {
      throw new Error('Ambiguous prepared release')
    }
    const tag = env.NEW_TAG || env.RECOVERED_TAG
    if (tag) {
      Object.assign(
        output,
        validateReleaseTag({
          sourceSha: env.SOURCE_SHA,
          tag,
          bundle: env.NEW_TAG ? env.BUNDLE_PATH : undefined,
          recovery: Boolean(env.RECOVERED_TAG),
          version: env.INPUT_VERSION,
          suffix: env.INPUT_SUFFIX,
          kind: env.INPUT_KIND
        })
      )
      if (env.RECOVERED_TAG && (await releaseState(tag))?.draft === false) {
        throw new Error('Recovered release is already published')
      }
      output.should_release = 'true'
    }
    if (env.LATEST_PUBLISHED_RC) {
      if (!env.LATEST_PUBLISHED_RC.includes('-rc.')) {
        throw new Error('Expected a published RC')
      }
      git(['update-ref', '-d', CANDIDATE])
      validateReleaseTag({
        sourceSha: env.SOURCE_SHA,
        tag: env.LATEST_PUBLISHED_RC,
        recovery: true
      })
      const release = await releaseState(env.LATEST_PUBLISHED_RC)
      if (!release || release.draft !== false) {
        throw new Error('RC recovery did not publish the release')
      }
      output.latest_published_rc_tag = env.LATEST_PUBLISHED_RC
    }
  }
  appendFileSync(
    env.GITHUB_OUTPUT,
    Object.entries(output)
      .map(([key, value]) => `${key}=${value}\n`)
      .join('')
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

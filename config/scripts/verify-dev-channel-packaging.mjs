#!/usr/bin/env node
// Why this exists: the dev-channel workflows run from main, but they build (and
// therefore read `config/electron-builder.config.cjs` from) whatever ref was
// asked for. A branch cut before Windows dev builds landed has a config that
// ignores ORCA_WIN_*, which would resolve `publish.repo` to the *main* repo and
// leave the release identity signed-looking. Publishing would then fail deep
// inside electron-builder with a 404 from a token scoped to the dev repo — or,
// worse, succeed against a repo it was never meant to touch.
//
// So: load the config exactly as electron-builder will, and assert the identity
// it produced matches the channel and platform the workflow believes it is
// building. Runs before packaging, fails with a sentence someone can act on.

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CHANNEL_REPOS = {
  hourly: 'orca-hourly',
  daily: 'orca-daily',
  adhoc: 'orca-adhoc'
}

const CHANNEL_VERSION_ENV = {
  hourly: 'ORCA_HOURLY_BUILD_VERSION',
  daily: 'ORCA_DAILY_BUILD_VERSION',
  adhoc: 'ORCA_ADHOC_BUILD_VERSION'
}

export function collectDevChannelPackagingProblems({ channel, platform, config, env }) {
  const problems = []
  const expectedRepo = CHANNEL_REPOS[channel]
  if (!expectedRepo) {
    return [
      `Unknown dev channel "${channel}"; expected one of ${Object.keys(CHANNEL_REPOS).join(', ')}.`
    ]
  }

  if (config.publish?.repo !== expectedRepo) {
    problems.push(
      `publish.repo is "${config.publish?.repo}" but this ${channel} build must publish to "${expectedRepo}". ` +
        `The checked-out ref's electron-builder config does not understand this channel on ${platform} — rebase it onto a main that does.`
    )
  }

  if (config.publish?.releaseType !== 'prerelease') {
    problems.push(
      `publish.releaseType is "${config.publish?.releaseType}" but dev-channel builds must publish as "prerelease".`
    )
  }

  // Why version too: `extraMetadata.version` is what stamps the tag the workflow
  // already created. A config that dropped it would package package.json's
  // version and upload into the wrong release entirely.
  const expectedVersion = env[CHANNEL_VERSION_ENV[channel]]
  if (expectedVersion && config.extraMetadata?.version !== expectedVersion) {
    problems.push(
      `extraMetadata.version is "${config.extraMetadata?.version}" but the workflow computed "${expectedVersion}".`
    )
  }

  if (platform === 'win32') {
    // The one that silently breaks updates rather than failing the build: a dev
    // build that advertises a publisherName can never install its own channel's
    // next build, because electron-updater verifies against the name baked into
    // the installed app.
    if (config.win?.verifyUpdateCodeSignature !== false) {
      problems.push(
        'win.verifyUpdateCodeSignature must be false for unsigned dev builds, or electron-updater will Authenticode-verify every installer this build downloads and reject all of them.'
      )
    }
    if (config.win?.signtoolOptions?.publisherName != null) {
      problems.push(
        `win.signtoolOptions.publisherName is set to "${config.win.signtoolOptions.publisherName}" on an unsigned dev build; it must be absent.`
      )
    }
  }

  return problems
}

function parseArgs(argv) {
  const args = {}
  for (const entry of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(entry)
    if (match) {
      args[match[1]] = match[2]
    }
  }
  return args
}

function main() {
  const { channel, platform = process.platform } = parseArgs(process.argv.slice(2))
  if (!channel) {
    console.error(
      'Usage: verify-dev-channel-packaging.mjs --channel=<hourly|daily|adhoc> [--platform=win32]'
    )
    process.exit(1)
  }
  const require = createRequire(import.meta.url)
  const config = require(resolve(import.meta.dirname, '../electron-builder.config.cjs'))
  const problems = collectDevChannelPackagingProblems({
    channel,
    platform,
    config,
    env: process.env
  })
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`::error::${problem}`)
    }
    process.exit(1)
  }
  console.log(
    `Dev-channel packaging verified: ${channel} on ${platform} → stablyai/${CHANNEL_REPOS[channel]} @ ${config.extraMetadata?.version}`
  )
}

// Why the guard: the test imports the pure collector without running the CLI.
// pathToFileURL, not a `file://` template: this also runs on Windows, where a
// drive-letter path does not concatenate into a valid URL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

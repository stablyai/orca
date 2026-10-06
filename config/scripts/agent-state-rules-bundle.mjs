// Builds and publishes the agent state rules bundle (agent-state-rules.json). The app's loader
// validates the same file (src/main/runtime/agent-state-rules/agent-state-rules-bundle.ts), and
// agent-state-rules-bundle.test.mjs proves the build passes it; this script only assembles the
// file and enforces the publishing rules a single file cannot express.
//
//   node config/scripts/agent-state-rules-bundle.mjs build <out> [--bundled-only]
//   node config/scripts/agent-state-rules-bundle.mjs publish-next [--bundled-only]
//   node config/scripts/agent-state-rules-bundle.mjs promote-stable

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { agentStateRulesTag } from './release-tag-patterns.mjs'

const RULES_DIR = join(import.meta.dirname, '..', '..', 'src/main/runtime/agent-state-rules')
export const AGENT_STATE_RULES_ASSET = 'agent-state-rules.json'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The live-updatable agents' files, in release order, under the release's version. */
export function buildAgentStateRulesBundle({ bundledOnly = false } = {}) {
  const release = readJson(join(RULES_DIR, 'agent-state-rules-release.json'))
  const files = release.liveUpdatable.map((id) => readJson(join(RULES_DIR, `${id}.json`)))
  const bundle = {
    version: release.version,
    engineVersion: files[0].engineVersion,
    ...(bundledOnly ? { bundledOnly: true } : {}),
    files
  }
  return `${JSON.stringify(bundle, null, 2)}\n`
}

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function ghOrThrow(gh, args) {
  const result = gh(args)
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

/** The file on `tag`'s release, or null when there is no release yet. */
function downloadPublished(gh, repo, tag) {
  const args = [
    'release',
    'download',
    tag,
    '--repo',
    repo,
    '-p',
    AGENT_STATE_RULES_ASSET,
    '-O',
    '-'
  ]
  const result = gh(args)
  if (result.status === 0) {
    return result.stdout
  }
  // Why throw on anything else, a missing asset included: that means an earlier upload broke.
  if (/release not found/i.test(result.stderr)) {
    return null
  }
  throw new Error(`gh ${args.join(' ')} failed: ${result.stderr.trim()}`)
}

/**
 * Puts `text` on the channel's release for its engine, as a prerelease that never becomes Latest
 * (the app updater follows Latest). `gh` is injectable so the sequence is testable.
 */
export function publishAgentStateRules({ repo, channel, text, target, gh = runGh }) {
  const candidate = JSON.parse(text)
  const tag = agentStateRulesTag(candidate.engineVersion, channel)
  const publishedText = downloadPublished(gh, repo, tag)
  // Why strictly higher: apps refuse a version they already have, so republishing one would reach
  // nobody, and a lower one would reach only apps that never took the higher.
  const published = publishedText === null ? null : JSON.parse(publishedText).version
  if (published !== null && candidate.version <= published) {
    throw new Error(
      `version ${candidate.version} is not higher than the published ${published}; bump agent-state-rules-release.json`
    )
  }
  const file = join(mkdtempSync(join(tmpdir(), 'agent-state-rules-')), AGENT_STATE_RULES_ASSET)
  writeFileSync(file, text)
  if (published === null) {
    ghOrThrow(gh, [
      'release',
      'create',
      tag,
      file,
      '--repo',
      repo,
      '--target',
      target,
      '--prerelease',
      '--latest=false',
      '--title',
      `Agent state rules (${channel})`,
      '--notes',
      'Agent state rules for Orca. Running apps download this file; it is not an app release.'
    ])
  } else {
    // Why --clobber on the same tag: the app's fixed URL stays valid, and a fetch that lands
    // mid-upload gets a 404 and keeps its last good copy.
    ghOrThrow(gh, ['release', 'upload', tag, file, '--repo', repo, '--clobber'])
  }
  return { tag, version: candidate.version }
}

/**
 * Why no rebuild and no re-gate: stable gets exactly the bytes RC and dev builds soaked on next,
 * which only the gated publish-next job writes. A bundledOnly next is promoted too: that is how
 * stable rolls back to the rules it shipped.
 */
export function promoteAgentStateRules({ repo, engineVersion, target, gh = runGh }) {
  const nextTag = agentStateRulesTag(engineVersion, 'next')
  const text = downloadPublished(gh, repo, nextTag)
  if (text === null) {
    throw new Error(`${nextTag} has not been published`)
  }
  return publishAgentStateRules({ repo, channel: 'stable', text, target, gh })
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set`)
  }
  return value
}

function main([command, ...args]) {
  const bundledOnly = args.includes('--bundled-only')
  switch (command) {
    case 'build': {
      const out = args.find((arg) => !arg.startsWith('--'))
      if (!out) {
        throw new Error('usage: build <out> [--bundled-only]')
      }
      writeFileSync(out, buildAgentStateRulesBundle({ bundledOnly }))
      return
    }
    case 'publish-next':
    case 'promote-stable': {
      const repo = requireEnv('GITHUB_REPOSITORY')
      const target = requireEnv('GITHUB_SHA')
      const text = buildAgentStateRulesBundle({ bundledOnly })
      const { tag, version } =
        command === 'publish-next'
          ? publishAgentStateRules({ repo, channel: 'next', text, target })
          : promoteAgentStateRules({ repo, engineVersion: JSON.parse(text).engineVersion, target })
      console.log(`Published version ${version} to ${tag}.`)
      return
    }
    default:
      throw new Error(`unknown command ${command ?? '(none)'}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

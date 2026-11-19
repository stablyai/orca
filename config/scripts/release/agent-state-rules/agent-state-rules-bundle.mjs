// Assemble rules accepted by the app loader and enforce channel publishing constraints.
// Usage: build <out> [--bundled-only] | publish-next [--bundled-only] | promote-stable.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  downloadChannelAsset,
  putChannelAsset,
  runGh
} from '../publication/channel-release-asset.mjs'
import { agentStateRulesTag } from '../versioning/release-tag-patterns.mjs'

const RULES_DIR = join(import.meta.dirname, '../../..', '..', 'src/main/runtime/agent-state-rules')
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

/** The file on `tag`'s release, or null when there is no release yet. */
function downloadPublished(gh, repo, tag) {
  return (
    downloadChannelAsset({ gh, repo, tag, asset: AGENT_STATE_RULES_ASSET })?.toString('utf8') ??
    null
  )
}

/**
 * Puts `text` on the channel's release for its engine, as a prerelease that never becomes Latest
 * (the app updater follows Latest). `gh` is injectable so the sequence is testable.
 */
export function publishAgentStateRules({ repo, channel, text, target, gh = runGh }) {
  const candidate = JSON.parse(text)
  const tag = agentStateRulesTag(candidate.engineVersion, channel)
  const publishedText = downloadPublished(gh, repo, tag)
  // Apps refuse existing/lower versions, so only strictly increasing publication reaches upgraded clients.
  const published = publishedText === null ? null : JSON.parse(publishedText).version
  if (published !== null && candidate.version <= published) {
    throw new Error(
      `version ${candidate.version} is not higher than the published ${published}; bump agent-state-rules-release.json`
    )
  }
  putChannelAsset({
    gh,
    repo,
    tag,
    asset: AGENT_STATE_RULES_ASSET,
    bytes: text,
    exists: published !== null,
    target,
    title: `Agent state rules (${channel})`,
    notes: 'Agent state rules for Orca. Running apps download this file; it is not an app release.'
  })
  return { tag, version: candidate.version }
}

// Promote exact gated next bytes without rebuilding; bundledOnly next also permits rollback to shipped rules.
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

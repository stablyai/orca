// The rules-release gate: the bundle a release would publish validates in the app's own loader,
// carries only agents whose transcripts the census replays, and only the protected workflow can
// publish it.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  BUNDLED_AGENT_STATE_RULES_VERSION,
  LIVE_UPDATABLE_AGENT_STATE_RULE_IDS,
  parseAgentStateRulesBundle
} from '../../src/main/runtime/agent-state-rules/agent-state-rules-bundle.ts'
import { BUNDLED_AGENT_STATE_RULE_FILES } from '../../src/main/runtime/agent-state-rules/agent-state-rules-catalog.ts'
import { agentStateRulesDownloadUrl } from '../../src/main/runtime/agent-state-rules/agent-state-rules-live-update.ts'
import {
  AGENT_STATE_RULES_ENGINE_VERSION,
  UNKNOWN_PANE_RULES_ID
} from '../../src/main/runtime/agent-state-rules/agent-state-rules-schema.ts'
import { CENSUS_TRANSCRIPTS } from '../../src/main/runtime/readiness-census-transcript-catalog.ts'
import {
  AGENT_STATE_RULES_ASSET,
  buildAgentStateRulesBundle,
  promoteAgentStateRules,
  publishAgentStateRules
} from './agent-state-rules-bundle.mjs'
import { agentStateRulesTag } from './release-tag-patterns.mjs'

const REPO = 'stablyai/orca'
const NEXT = agentStateRulesTag(1, 'next')
const STABLE = agentStateRulesTag(1, 'stable')

describe('agent state rules bundle build', () => {
  it('builds a bundle the app accepts, under the bundled version and engine', () => {
    const text = buildAgentStateRulesBundle()
    const parsed = parseAgentStateRulesBundle(text, 'live-updatable')
    expect(parsed.ok).toBe(true)
    const bundle = JSON.parse(text)
    expect(bundle.engineVersion).toBe(AGENT_STATE_RULES_ENGINE_VERSION)
    expect(bundle.version).toBe(BUNDLED_AGENT_STATE_RULES_VERSION)
    expect(bundle.files).toEqual(
      BUNDLED_AGENT_STATE_RULE_FILES.filter((file) =>
        LIVE_UPDATABLE_AGENT_STATE_RULE_IDS.has(file.id)
      )
    )
    expect(bundle.bundledOnly).toBeUndefined()
    expect(JSON.parse(buildAgentStateRulesBundle({ bundledOnly: true })).bundledOnly).toBe(true)
  })

  it('lets a rules release change only agents the readiness census replays', () => {
    const replayed = new Set(CENSUS_TRANSCRIPTS.flatMap((transcript) => transcript.agent ?? []))
    // Why unknown-pane: the census replays every recording on an agent-unknown pane too.
    replayed.add(UNKNOWN_PANE_RULES_ID)
    expect([...LIVE_UPDATABLE_AGENT_STATE_RULE_IDS].filter((id) => !replayed.has(id))).toEqual([])
  })

  it('publishes to the exact URL the app fetches', () => {
    for (const channel of ['next', 'stable']) {
      expect(agentStateRulesDownloadUrl(channel)).toBe(
        `https://github.com/${REPO}/releases/download/${agentStateRulesTag(AGENT_STATE_RULES_ENGINE_VERSION, channel)}/${AGENT_STATE_RULES_ASSET}`
      )
    }
  })
})

/** A `gh` stand-in over an in-memory set of releases, recording each call. */
function fakeGh(releases = {}) {
  const calls = []
  const gh = (args) => {
    calls.push(args)
    const [, verb, tag] = args
    if (verb === 'download') {
      return tag in releases
        ? { status: 0, stdout: releases[tag], stderr: '' }
        : { status: 1, stdout: '', stderr: 'release not found' }
    }
    if (verb === 'upload' || verb === 'create') {
      expect(args[3].endsWith(`/${AGENT_STATE_RULES_ASSET}`)).toBe(true)
      releases[tag] = readFileSync(args[3], 'utf8')
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { gh, calls, releases }
}

const at = (version, engineVersion = 1) =>
  `${JSON.stringify({ version, engineVersion, files: [] })}\n`

describe('publishAgentStateRules', () => {
  it("creates the engine's channel release as a prerelease that can never be Latest", () => {
    const fake = fakeGh()
    expect(
      publishAgentStateRules({
        repo: REPO,
        channel: 'next',
        text: at(2),
        target: 'abc',
        gh: fake.gh
      })
    ).toEqual({ tag: NEXT, version: 2 })
    expect(fake.calls.find((args) => args[1] === 'create')).toEqual(
      expect.arrayContaining([NEXT, '--prerelease', '--latest=false', '--target', 'abc'])
    )
    expect(fake.releases[NEXT]).toBe(at(2))
  })

  it('replaces the asset in place on an existing release, keeping the tag', () => {
    const fake = fakeGh({ [NEXT]: at(1) })
    publishAgentStateRules({ repo: REPO, channel: 'next', text: at(2), target: 'abc', gh: fake.gh })
    expect(fake.calls.map((args) => args[1])).toEqual(['download', 'upload'])
    expect(fake.calls[1]).toContain('--clobber')
    expect(fake.releases[NEXT]).toBe(at(2))
  })

  it.each([1, 2])('refuses version %s over a published 2, uploading nothing', (version) => {
    const fake = fakeGh({ [NEXT]: at(2) })
    expect(() =>
      publishAgentStateRules({
        repo: REPO,
        channel: 'next',
        text: at(version),
        target: 'abc',
        gh: fake.gh
      })
    ).toThrow('bump agent-state-rules-release.json')
    expect(fake.calls.map((args) => args[1])).toEqual(['download'])
  })

  it('fails when the release exists but its download fails', () => {
    const gh = () => ({ status: 1, stdout: '', stderr: 'no assets match the file pattern' })
    expect(() =>
      publishAgentStateRules({ repo: REPO, channel: 'next', text: at(2), target: 'abc', gh })
    ).toThrow('no assets match')
  })

  it('promotes the identical next bytes to stable', () => {
    const nextText = JSON.stringify({ version: 3, engineVersion: 1, files: [] }, null, 2)
    const fake = fakeGh({ [NEXT]: nextText, [STABLE]: at(2) })
    promoteAgentStateRules({ repo: REPO, engineVersion: 1, target: 'abc', gh: fake.gh })
    expect(fake.releases[STABLE]).toBe(nextText)
  })

  it('refuses to promote before next exists', () => {
    const fake = fakeGh()
    expect(() =>
      promoteAgentStateRules({ repo: REPO, engineVersion: 1, target: 'abc', gh: fake.gh })
    ).toThrow('has not been published')
  })
})

describe('agent state rules workflows', () => {
  const read = (name) => parse(readFileSync(`.github/workflows/${name}`, 'utf8'))
  const publish = read('agent-state-rules-publish.yml')

  it('publishes only on manual dispatch from main, in the protected environment', () => {
    expect(Object.keys(publish.on)).toEqual(['workflow_dispatch'])
    for (const name of ['publish-next', 'promote-stable']) {
      const job = publish.jobs[name]
      expect(job.environment).toBe('agent-state-rules')
      expect(job.permissions).toEqual({ contents: 'write' })
    }
    expect(publish.permissions).toEqual({ contents: 'read' })
    expect(publish.jobs.gate.if).toContain("github.ref == 'refs/heads/main'")
    expect(publish.jobs['promote-stable'].if).toContain("github.ref == 'refs/heads/main'")
    expect(publish.jobs['publish-next'].needs).toBe('gate')
    // Why: every job must check out the dispatched commit, so publish runs what the gate tested.
    const checkouts = Object.values(publish.jobs).flatMap((job) =>
      job.steps.filter((step) => step.uses?.startsWith('actions/checkout'))
    )
    expect(checkouts.map((step) => step.with?.ref)).toEqual([undefined, undefined, undefined])
  })

  it('is the only workflow that publishes rules releases', () => {
    const publishers = readdirSync('.github/workflows').filter((name) =>
      /agent-state-rules-bundle\.mjs (?:publish|promote)|release create agent-state-rules/.test(
        readFileSync(`.github/workflows/${name}`, 'utf8')
      )
    )
    expect(publishers).toEqual(['agent-state-rules-publish.yml'])
  })
})

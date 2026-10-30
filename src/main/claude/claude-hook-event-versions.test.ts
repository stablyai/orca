import { describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { readManagedHookDetectionResult } from '../agent-hooks/managed-hook-detection-commands'
import { getClaudeManagedHookPlan } from './claude-managed-hook-events'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
import { compareAppVersions } from '../../shared/app-version'
import fixture from './__fixtures__/claude-hook-event-enums.json'
import {
  CLAUDE_HOOK_EVENT_FIRST_VERSIONS,
  CLAUDE_STATUS_LINE_FIRST_VERSION,
  claudeKnowsHookEvent,
  claudeKnowsStatusLine,
  parseClaudeCliVersion,
  parseClaudeCliVersionOutput,
  probeClaudeCliVersion,
  UNRESOLVED_CLAUDE_VERSION,
  type ClaudeHookEventName
} from './claude-hook-event-versions'

const enums: Record<string, string[]> = fixture.enums
const previousPublished: Record<string, string> = fixture.previousPublishedVersion
const topLevelSettings: Record<string, { strict: boolean; keys: string[] }> =
  fixture.topLevelSettings
const versions = Object.keys(enums).sort(compareAppVersions)
const isTableEvent = (name: string): name is ClaudeHookEventName =>
  name in CLAUDE_HOOK_EVENT_FIRST_VERSIONS
const tableEntries = Object.keys(CLAUDE_HOOK_EVENT_FIRST_VERSIONS)
  .filter(isTableEvent)
  .map((event): [ClaudeHookEventName, string] => [event, CLAUDE_HOOK_EVENT_FIRST_VERSIONS[event]])

describe('Claude hook event version table', () => {
  it.each(tableEntries)('pins %s to the first release whose enum knows it', (event, first) => {
    expect(versions.find((version) => enums[version].includes(event))).toBe(first)
    for (const version of versions) {
      expect(enums[version].includes(event), `${event} in ${version}`).toBe(
        compareAppVersions(version, first) >= 0
      )
    }
    const before = previousPublished[first]
    expect(enums[before], `enum for ${before}`).toBeDefined()
    expect(enums[before]).not.toContain(event)
  })
})

describe('Claude statusLine version floor', () => {
  it('pins statusLine to the first release whose settings schema knows it', () => {
    for (const [version, schema] of Object.entries(topLevelSettings)) {
      expect(schema.keys.includes('statusLine'), version).toBe(
        compareAppVersions(version, CLAUDE_STATUS_LINE_FIRST_VERSION) >= 0
      )
    }
    const before = previousPublished[CLAUDE_STATUS_LINE_FIRST_VERSION]
    expect(topLevelSettings[before].strict).toBe(true)
    expect(topLevelSettings[before].keys).not.toContain('statusLine')
  })

  it.each([
    ['1.0.63', false],
    ['1.0.64 (Claude Code)', true],
    [undefined, true]
  ] as const)('%s knows statusLine: %s', (version, expected) => {
    expect(claudeKnowsStatusLine(version)).toBe(expected)
  })
})

describe('claudeKnowsHookEvent', () => {
  it.each([
    ['2.1.77', 'StopFailure', false],
    ['2.1.78 (Claude Code)', 'StopFailure', true],
    ['2.1.75', 'PostCompact', false],
    ['2.1.76', 'PostCompact', true],
    ['2.1.32', 'TeammateIdle', false],
    ['2.0.55', 'PostToolUseFailure', false],
    ['2.0.44', 'PermissionRequest', false],
    ['2.0.42', 'SubagentStart', false],
    ['1.0.84', 'SessionEnd', false],
    ['1.0.61', 'SessionStart', false],
    ['1.0.62', 'SessionStart', true],
    ['1.0.52', 'UserPromptSubmit', false],
    ['1.0.40', 'SubagentStop', false],
    ['1.0.30', 'Stop', false],
    ['1.0.22', 'PreToolUse', false]
  ] as const)('%s knows %s: %s', (version, event, expected) => {
    expect(claudeKnowsHookEvent(version, event)).toBe(expected)
  })

  it.each([undefined, null, 'unknown'])(
    'grants an unresolved version (%s) only the events its assumed release knows',
    (version) => {
      const known = tableEntries
        .filter(([event]) => claudeKnowsHookEvent(version, event))
        .map(([event]) => event)
      expect(known.sort()).toEqual(
        [
          'PostToolUse',
          'PreToolUse',
          'SessionStart',
          'Stop',
          'SubagentStop',
          'UserPromptSubmit'
        ].sort()
      )
      for (const event of known) {
        expect(enums[UNRESOLVED_CLAUDE_VERSION]).toContain(event)
      }
    }
  )
})

describe('parseClaudeCliVersion', () => {
  it('extracts Claude Code version output', () => {
    expect(parseClaudeCliVersion('2.1.261 (Claude Code)')).toBe('2.1.261')
    expect(parseClaudeCliVersion('unknown')).toBeNull()
    expect(parseClaudeCliVersion('2.1.261')).toBe('2.1.261')
  })
})

describe('identified Claude version output', () => {
  // Recorded macOS 2.1.310 / Windows 2.1.221 probes; historical releases' CLI source
  // registers the same suffix (1.0.23, 1.0.64, 2.0.0 and 2.1.100).
  it.each([
    ['2.1.310 (Claude Code)\n', '', '2.1.310', 15, 0],
    ['2.1.221 (Claude Code)\n', '', '2.1.221', 14, 1],
    ['1.0.23 (Claude Code)', '', '1.0.23', 2, 13],
    ['1.0.64 (Claude Code)', '', '1.0.64', 6, 9],
    ['2.0.0 (Claude Code)', '', '2.0.0', 6, 9],
    ['2.1.100 (Claude Code)', '', '2.1.100', 14, 1],
    ['launcher 11.17.0\n1.0.64 (Claude Code)', '', '1.0.64', 6, 9],
    ['launcher 0.1.0\n2.1.310 (Claude Code)', '', '2.1.310', 15, 0],
    ['launcher 0.1.0', '2.1.310 (Claude Code)\n', '2.1.310', 15, 0],
    ['', '2.1.310 (Claude Code)\n', '2.1.310', 15, 0],
    ['2.1.94-rc.1+build.2 (Claude Code)', '', '2.1.94-rc.1+build.2', 14, 1],
    ['11.17.0\n', '', null, 6, 0],
    ['2.30.0', '', null, 6, 0],
    ['2.1.310\nwrapper for (Claude Code)', '', null, 6, 0],
    ['2.1.310\n(Claude Code)', '', null, 6, 0],
    ['2.1 (Claude Code)', '', null, 6, 0]
  ] as const)(
    'uses the identified version and hook plan for stdout=%s stderr=%s',
    async (stdout, stderr, expected, installs, retirements) => {
      vi.mocked(runProcess).mockResolvedValue({
        stdout,
        stderr,
        code: 0,
        signal: null,
        timedOut: false
      })
      const local = await probeClaudeCliVersion('/bin/claude')
      // Older guests send combined raw output, not canonical stored semver.
      const remote = readManagedHookDetectionResult({
        agents: ['claude'],
        versions: { claude: `${stdout}\n${stderr}` }
      })
      expect(remote.agents).toEqual(['claude'])
      expect(parseClaudeCliVersionOutput(`${stdout}\n${stderr}`)).toBe(expected)
      for (const version of [local, remote.claudeVersion]) {
        expect(version).toBe(expected)
        const plan = getClaudeManagedHookPlan(version)
        expect(plan.install).toHaveLength(installs)
        expect(plan.retire).toHaveLength(retirements)
        expect(plan.statusLine).toBe(expected === '1.0.23' ? 'retire' : 'install')
      }
    }
  )

  it('does not accept marked output from a failed probe', async () => {
    vi.mocked(runProcess).mockResolvedValue({
      stdout: '2.1.310 (Claude Code)\n',
      stderr: '',
      code: 1,
      signal: null,
      timedOut: false
    })
    expect(await probeClaudeCliVersion('/bin/claude')).toBeNull()
  })
})

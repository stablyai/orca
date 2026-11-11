import { describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { readManagedHookDetectionResult } from '../agent-hooks/installation/managed-hook-detection-commands'
import { getClaudeManagedHookPlan } from './claude-managed-hook-events'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))

import {
  parseClaudeCliVersion,
  parseClaudeCliVersionOutput,
  probeClaudeCliVersion
} from './claude-hook-event-versions'

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
    ['2.1.310 (Claude Code)\n', '', '2.1.310', 16, 0],
    ['2.1.221 (Claude Code)\n', '', '2.1.221', 15, 1],
    ['1.0.23 (Claude Code)', '', '1.0.23', 2, 14],
    ['1.0.64 (Claude Code)', '', '1.0.64', 6, 10],
    ['2.0.0 (Claude Code)', '', '2.0.0', 6, 10],
    ['2.1.100 (Claude Code)', '', '2.1.100', 14, 2],
    ['launcher 11.17.0\n1.0.64 (Claude Code)', '', '1.0.64', 6, 10],
    ['launcher 0.1.0\n2.1.310 (Claude Code)', '', '2.1.310', 16, 0],
    ['launcher 0.1.0', '2.1.310 (Claude Code)\n', '2.1.310', 16, 0],
    ['', '2.1.310 (Claude Code)\n', '2.1.310', 16, 0],
    ['2.1.94-rc.1+build.2 (Claude Code)', '', '2.1.94-rc.1+build.2', 14, 2],
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

describe('getClaudeManagedHookPlan', () => {
  it('retires PermissionRequest while the guard skip is in use and installs it otherwise', () => {
    const names = (events: readonly { eventName: string }[]) => events.map((e) => e.eventName)
    expect(names(getClaudeManagedHookPlan('2.1.319').install)).toContain('PermissionRequest')
    const skipping = getClaudeManagedHookPlan('2.1.319', true)
    expect(names(skipping.install)).not.toContain('PermissionRequest')
    expect(names(skipping.retire)).toEqual(['PermissionRequest'])
    // A failed probe retires nothing else, but must still drop the entry that blocks the waiver.
    expect(names(getClaudeManagedHookPlan(null, true).retire)).toEqual(['PermissionRequest'])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillInstallResult } from '../../shared/skill-install-contract'

import type { WslResult, WslSpec } from '../wsl/execution/wsl-runner'
import type { discoverSkills } from './discovery'

const transport = vi.hoisted(() => ({
  run: vi.fn<(spec: WslSpec) => Promise<WslResult>>(),
  native: vi.fn<typeof discoverSkills>()
}))
vi.mock('../wsl/execution/wsl-runner', () => ({ runWslProcess: transport.run }))
vi.mock('./discovery', () => ({ discoverSkills: transport.native }))

import './skill-discovery-wsl'
import { verifySkillInstallDiscovery } from './skill-install-discovery-verification'

const home = '/home/alice'
const homeAgents = `${home}/.agents/skills`
const homeClaude = `${home}/.claude/skills`
const pluginRoot = `${home}/.claude/plugins/cache/example/1/skills`
type ScanRow = { root: string; directory: string; canonical: string; name: string }

function skillRow(root: string, canonical = `${root}/review`, directory = 'review'): ScanRow {
  return { root, directory: `${root}/${directory}`, canonical, name: 'review' }
}

function installResult(paths: string[], name = 'review'): SkillInstallResult {
  return {
    operationId: 'wsl-install',
    status: 'installed',
    name,
    packageDigest: 'a'.repeat(64),
    canonicalPath: paths[0],
    placements: paths.map((path, index) => ({
      provider: index === 0 ? 'agent-skills' : 'claude',
      path,
      topology: index === 0 ? 'canonical-copy' : 'provider-alias',
      status: 'installed'
    }))
  }
}

function record(...fields: string[]): string {
  return `${fields.join('\0')}\0`
}

function wslResult(stdout: string): WslResult {
  return { environmentResolved: true, code: 0, stdout, stderr: '', timedOut: false }
}

function interceptScan(rows: ScanRow[]): void {
  transport.run.mockImplementation(async (spec) => {
    if (!spec.script) {
      throw new Error('Expected a discovery script')
    }
    if (spec.script.includes('read_metadata()')) {
      const installed = {
        plugins: {
          'example@marketplace': [
            { scope: 'user', installPath: pluginRoot.slice(0, -'/skills'.length) }
          ]
        }
      }
      const settings = { enabledPlugins: { 'example@marketplace': true } }
      return wslResult(
        record('F', '0', '1', Buffer.from(JSON.stringify(installed)).toString('base64')) +
          record('F', '1', '1', Buffer.from(JSON.stringify(settings)).toString('base64')) +
          record('F', '2', '0', '') +
          record('F', '3', '0', '')
      )
    }
    let stdout = ''
    // Keep discovery real so a wrapper-only mock cannot hide extra process starts.
    for (const match of spec.script.matchAll(/^scan_root (\d+) '([^']+)' \d+$/gm)) {
      const [, index, root] = match
      const rootRows = rows.filter((row) => row.root === root)
      stdout += record('R', index, rootRows.length ? '1' : '0')
      for (const row of rootRows) {
        const markdown = Buffer.from(`---\nname: ${row.name}\ndescription: Review work\n---\n`)
        stdout += record(
          'S',
          index,
          `${row.directory}/SKILL.md`,
          `${row.canonical}/SKILL.md`,
          '1700000000',
          markdown.toString('base64')
        )
      }
    }
    return wslResult(stdout)
  })
}

const input = {
  scope: 'global',
  homeDirectory: home,
  wslDistro: 'Ubuntu'
} as const
const missingPlacement = {
  status: 'failed',
  errorCategory: 'skill-discovery-placement-missing',
  failure: {
    category: 'provider-placement',
    code: 'skill-discovery-placement-missing',
    retryable: true
  }
} as const

beforeEach(() => {
  transport.run.mockReset()
  transport.native.mockReset()
})

describe('WSL install verification at the discovery transport boundary', () => {
  it('reads again for each item and fails if its canonical placement disappears', async () => {
    const result = installResult([`${homeAgents}/review`])
    interceptScan([skillRow(homeAgents)])
    expect(await verifySkillInstallDiscovery({ ...input, result })).toEqual(result)
    interceptScan([skillRow(pluginRoot, `${homeAgents}/review`)])
    expect(await verifySkillInstallDiscovery({ ...input, result })).toEqual({
      ...result,
      status: 'failed',
      placements: [{ ...result.placements[0], ...missingPlacement }],
      errorCategory: 'skill-discovery-canonical-missing',
      failure: {
        category: 'provider-placement',
        code: 'skill-discovery-canonical-missing',
        retryable: true
      }
    })
    expect(transport.run).toHaveBeenCalledTimes(2)
    expect(transport.run.mock.calls.every(([spec]) => spec.script?.includes('scan_root()'))).toBe(
      true
    )
  })

  it('returns partial with the same provider error when an installed alias is missing', async () => {
    const result = installResult([`${homeAgents}/review`, `${homeClaude}/review`])
    result.placements[0].status = 'unchanged'
    interceptScan([skillRow(homeAgents)])
    expect(await verifySkillInstallDiscovery({ ...input, result })).toEqual({
      ...result,
      status: 'partial',
      placements: [result.placements[0], { ...result.placements[1], ...missingPlacement }]
    })
    expect(transport.run).toHaveBeenCalledTimes(1)
  })

  it.each([
    { ...wslResult(''), code: 1 },
    { ...wslResult(''), timedOut: true },
    wslResult(record('S', '0'))
  ])('fails the mandatory proof for scan response %#', async (response) => {
    const result = installResult([`${homeAgents}/review`])
    transport.run.mockResolvedValue(response)
    expect(await verifySkillInstallDiscovery({ ...input, result })).toEqual({
      ...result,
      status: 'failed',
      errorCategory: 'skill-discovery-verification-failed',
      failure: {
        category: 'provider-placement',
        code: 'skill-discovery-verification-failed',
        retryable: true
      }
    })
    expect(transport.run).toHaveBeenCalledTimes(1)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillInstallResult } from '../../shared/skill-install-contract'
import type { SkillDiscoveryResult } from '../../shared/skills'
import type { WslResult, WslSpec } from '../wsl/wsl-runner'
import type { discoverSkills } from './discovery'

const transport = vi.hoisted(() => ({
  run: vi.fn<(spec: WslSpec) => Promise<WslResult>>(),
  native: vi.fn<typeof discoverSkills>()
}))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: transport.run }))
vi.mock('./discovery', () => ({ discoverSkills: transport.native }))

import { discoverSkillsInWsl } from './skill-discovery-wsl'
import { verifySkillInstallDiscovery } from './skill-install-discovery-verification'

const home = '/home/alice'
const workspace = '/work/project'
const homeAgents = `${home}/.agents/skills`
const homeClaude = `${home}/.claude/skills`
const repoAgents = `${workspace}/.agents/skills`
const repoClaude = `${workspace}/.claude/skills`
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

function scanScript(): string {
  const script = transport.run.mock.calls.at(-1)?.[0].script
  if (!script) {
    throw new Error('Expected a mandatory scan')
  }
  return script
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
  it.each(['global', 'workspace'] as const)(
    'uses one fresh scan instead of two processes for a %s install with co-owners',
    async (scope) => {
      const canonicalRoot = scope === 'global' ? homeAgents : repoAgents
      const aliasRoot = scope === 'global' ? homeClaude : repoClaude
      const coownerRoot = scope === 'global' ? repoAgents : homeClaude
      const canonical = `${canonicalRoot}/review`
      const result = installResult([canonical, `${aliasRoot}/review`])
      interceptScan([
        skillRow(canonicalRoot),
        skillRow(aliasRoot, canonical),
        skillRow(coownerRoot, canonical),
        skillRow(pluginRoot, canonical)
      ])
      const args = { ...input, scope, workspaceDirectory: workspace, result }
      const broad = await verifySkillInstallDiscovery({
        ...args,
        discover: () => discoverSkillsInWsl({ distro: 'Ubuntu', homeDir: home, cwd: workspace })
      })
      expect(broad).toEqual(result)
      expect(transport.run).toHaveBeenCalledTimes(2)
      expect(scanScript()).toContain(`'${pluginRoot}'`)
      transport.run.mockClear()

      expect(await verifySkillInstallDiscovery(args)).toEqual(broad)
      expect(transport.run).toHaveBeenCalledTimes(1)
      expect(transport.native).not.toHaveBeenCalled()
      expect(transport.run).toHaveBeenCalledWith(
        expect.objectContaining({
          distro: 'Ubuntu',
          shell: 'bash',
          loginPath: 'none',
          timeoutMs: 10_000,
          maxOutputBytes: 128 * 1024 * 1024
        })
      )
      expect(scanScript()).toContain(`'${homeAgents}'`)
      expect(scanScript()).toContain(`'${repoAgents}'`)
      expect(scanScript()).toContain("'review') return 0 ;;")
      expect(scanScript()).not.toContain('read_metadata()')
      expect(scanScript()).not.toContain(`'${pluginRoot}'`)
      expect(scanScript()).not.toContain(`'${home}/.codex/plugins/cache'`)
    }
  )

  it('keeps an overridden provider root even when it is also an enabled plugin root', async () => {
    const canonical = `${homeAgents}/review`
    const result = installResult([canonical, `${pluginRoot}/review`])
    interceptScan([skillRow(homeAgents), skillRow(pluginRoot, canonical)])
    const args = {
      ...input,
      result,
      providerRootOverrides: {
        claude:
          '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.claude\\plugins\\cache\\example\\1\\skills'
      }
    }
    const broad = await verifySkillInstallDiscovery({
      ...args,
      discover: () =>
        discoverSkillsInWsl({
          distro: 'Ubuntu',
          homeDir: home,
          providerRootOverrides: { claude: pluginRoot }
        })
    })
    expect(broad).toEqual(result)
    expect(transport.run).toHaveBeenCalledTimes(2)
    transport.run.mockClear()
    expect(await verifySkillInstallDiscovery(args)).toEqual(broad)
    expect(transport.run).toHaveBeenCalledTimes(1)
    expect(scanScript()).toContain(`'${pluginRoot}'`)
    expect(scanScript()).not.toContain('read_metadata()')
  })

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

  it.each(['review', 'Review', 'réview'])(
    'verifies frontmatter name %s in a different directory without accepting unrelated siblings',
    async (name) => {
      const result = installResult([`${homeAgents}/review`], name)
      interceptScan([
        { ...skillRow(homeAgents, `${homeAgents}/renamed`, 'renamed'), name },
        { ...skillRow(homeAgents, `${homeAgents}/other`, 'other'), name: 'other' }
      ])
      expect(await verifySkillInstallDiscovery({ ...input, result })).toEqual(result)
      expect(transport.run).toHaveBeenCalledTimes(1)
      expect(scanScript()).toContain('matches_requested_name()')
    }
  )

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

  it('leaves native fresh discovery arguments and answered co-owner proof unchanged', async () => {
    const result = installResult([`${homeAgents}/review`, `${homeClaude}/review`])
    const discovery: SkillDiscoveryResult = {
      scannedAt: 1,
      skills: [
        {
          id: 'review',
          name: 'review',
          description: null,
          providers: ['agent-skills', 'claude'],
          sourceKind: 'home',
          sourceLabel: 'Home',
          rootPath: homeAgents,
          rootPaths: [homeAgents, homeClaude],
          directoryPath: `${homeAgents}/review`,
          skillFilePath: `${homeAgents}/review/SKILL.md`,
          installed: true,
          updatedAt: null
        }
      ],
      sources: [
        {
          id: 'home-agents',
          label: 'Home',
          path: homeAgents,
          sourceKind: 'home',
          providers: ['agent-skills'],
          owner: null,
          exists: true,
          skippedReason: 'unavailable'
        }
      ]
    }
    transport.native.mockResolvedValue(discovery)
    expect(
      await verifySkillInstallDiscovery({ result, scope: 'global', homeDirectory: home })
    ).toEqual(result)
    expect(transport.native).toHaveBeenCalledExactlyOnceWith({
      homeDir: home,
      repos: [],
      refresh: true,
      includeCwd: false
    })
    expect(transport.run).not.toHaveBeenCalled()
  })
})

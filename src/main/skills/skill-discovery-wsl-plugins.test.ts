import type { WslResult } from '../wsl/wsl-runner'
import { posix as pathPosix } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())

vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { buildSkillDiscoverySources } from './skill-discovery-sources'
import { discoverSkillsInWsl } from './skill-discovery-wsl'

function record(...fields: string[]): string {
  return `${fields.join('\0')}\0`
}

function wslResult(stdout: string): WslResult {
  return { environmentResolved: true, code: 0, stdout, stderr: '', timedOut: false }
}

describe('WSL Claude plugin skill discovery', () => {
  beforeEach(() => runWslProcessMock.mockReset())
  afterEach(() => vi.unstubAllEnvs())

  it('reads enabled plugin metadata and scans the selected install inside the distro', async () => {
    const homeDir = '/home/alice'
    const cwd = '/work/orca'
    // Why: a Windows host's own Hermes location says nothing about the distro's,
    // so neither variable may reach the posix scan script.
    vi.stubEnv('HERMES_HOME', 'C:\\Users\\alice\\hermes')
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\alice\\AppData\\Local')
    const pluginId = 'compound-engineering@compound-engineering-plugin'
    const installPath = '/home/alice/.claude/plugins/cache/compound/3.14.3'
    const installed = JSON.stringify({
      plugins: {
        [pluginId]: [{ scope: 'project', projectPath: cwd, installPath }]
      }
    })
    const settings = JSON.stringify({ enabledPlugins: { [pluginId]: true } })
    const metadataOutput = [
      record('F', '0', '1', Buffer.from(installed).toString('base64')),
      record('F', '1', '1', Buffer.from(settings).toString('base64')),
      record('F', '2', '0', ''),
      record('F', '3', '0', '')
    ].join('')
    const baseRootCount = buildSkillDiscoverySources({
      homeDir,
      cwd,
      repos: [],
      pathApi: pathPosix
    }).length
    const skillPath = `${installPath}/skills/ce-plan/SKILL.md`
    const markdown = Buffer.from('---\nname: ce-plan\ndescription: Plan work.\n---\n').toString(
      'base64'
    )
    const scanOutput = [
      record('R', String(baseRootCount), '1'),
      record('S', String(baseRootCount), skillPath, skillPath, '1700000000', markdown)
    ].join('')
    runWslProcessMock.mockResolvedValueOnce(wslResult(metadataOutput))
    runWslProcessMock.mockResolvedValueOnce(wslResult(scanOutput))

    const result = await discoverSkillsInWsl({ distro: 'Ubuntu', homeDir, cwd })

    expect(runWslProcessMock).toHaveBeenCalledTimes(2)
    const scanScript = runWslProcessMock.mock.calls[1]?.[0].script as string
    expect(scanScript).toContain('/home/alice/.hermes/skills')
    expect(scanScript).not.toContain('AppData')
    expect(scanScript).toContain(`${installPath}/skills`)
    expect(result.skills).toEqual([
      expect.objectContaining({
        name: 'ce-plan',
        sourceKind: 'plugin',
        rootPath: `${installPath}/skills`
      })
    ])
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: `${installPath}/skills`, owner: 'claude', exists: true })
      ])
    )
  })
})

import { posix as pathPosix } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { buildSkillDiscoverySources } from './skill-discovery-sources'
import { discoverSkillsInWsl } from './skill-discovery-wsl'

function record(...fields: string[]): string {
  return `${fields.join('\0')}\0`
}

function completeExecFileCall(callIndex: number, stdout: string): void {
  const callback = execFileMock.mock.calls[callIndex]?.[3] as
    | ((error: Error | null, stdout: string) => void)
    | undefined
  callback?.(null, stdout)
}

describe('WSL Claude plugin skill discovery', () => {
  beforeEach(() => execFileMock.mockReset())

  it('reads enabled plugin metadata and scans the selected install inside the distro', async () => {
    const homeDir = '/home/alice'
    const cwd = '/work/orca'
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
      record('S', String(baseRootCount), skillPath, skillPath, '1700000000', '2', markdown)
    ].join('')
    execFileMock.mockImplementationOnce((..._args: unknown[]) => {
      queueMicrotask(() => completeExecFileCall(0, metadataOutput))
    })
    execFileMock.mockImplementationOnce((..._args: unknown[]) => {
      queueMicrotask(() => completeExecFileCall(1, scanOutput))
    })

    const result = await discoverSkillsInWsl({ distro: 'Ubuntu', homeDir, cwd })

    expect(execFileMock).toHaveBeenCalledTimes(2)
    const scanArgs = execFileMock.mock.calls[1]?.[1] as string[]
    const encoded = /printf %s '([^']+)'/.exec(scanArgs[5] ?? '')?.[1]
    const scanScript = Buffer.from(encoded ?? '', 'base64').toString('utf8')
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

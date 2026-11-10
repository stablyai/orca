import { describe, expect, it, vi } from 'vitest'
import { parsePluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { assertPluginWorkerCommand, workerCommandArgs } from './plugin-command-invocation'
import type { PluginWorkspaceCommandArgs } from '../../shared/plugins/contributions/plugin-workspace-command-args'

function plugin(capabilities = [{ kind: 'workspace:read' }]): ValidDiscoveredPlugin {
  const parsed = parsePluginManifest({
    manifestVersion: 2,
    execution: 'trusted-worker',
    id: 'engine',
    name: 'Engine',
    version: '1.0.0',
    engines: { orca: '>=1.4.246' },
    main: 'main.mjs',
    contributes: {
      commands: [
        { id: 'open-project', title: 'Open project', when: 'workspace' },
        { id: 'refresh', title: 'Refresh' }
      ]
    },
    capabilities
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return {
    pluginKey: 'orca-samples.engine',
    rootDir: '/plugins/engine',
    manifest: parsed.manifest,
    consentFingerprint: 'fingerprint',
    contentHash: null,
    isDev: true
  }
}

type Workspace = PluginWorkspaceCommandArgs['worktree']

const worktree: Workspace = {
  path: '/work/game',
  displayName: 'game',
  branch: 'feature',
  host: 'local'
}

async function argsFor(
  commandId: string,
  args: unknown,
  resolved: Workspace | null = worktree,
  target = plugin()
) {
  const resolve = vi.fn(async () => resolved)
  const command = assertPluginWorkerCommand(target, commandId)
  return { result: workerCommandArgs(target, command, args, resolve), resolve }
}

describe('worker command args', () => {
  it('passes other args through unchanged', async () => {
    const { result, resolve } = await argsFor('refresh', { page: 2 })
    await expect(result).resolves.toEqual({ page: 2 })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('hands a workspace command the workspace a worktree id names', async () => {
    const { result, resolve } = await argsFor('open-project', { worktreeId: 'r::/work/game' })
    await expect(result).resolves.toEqual({ worktree })
    expect(resolve).toHaveBeenCalledWith('r::/work/game')
  })

  it('resolves a badge subfolder on the workspace host and refuses one outside it', async () => {
    const request = { worktreeId: 'r::/work/game', folder: 'Games\\Racer' }
    const ssh = await argsFor('open-project', request, { ...worktree, host: 'ssh' })
    await expect(ssh.result).resolves.toMatchObject({
      folder: { path: '/work/game/Games/Racer', relativePath: 'Games/Racer' }
    })
    const outside = await argsFor('open-project', { ...request, folder: '../other' })
    await expect(outside.result).rejects.toThrow('That folder is not inside this workspace.')
  })

  it('never forwards the worktree id, which embeds the folder path', async () => {
    const request = { worktreeId: 'r::/work/game' }
    await expect((await argsFor('refresh', request)).result).resolves.toBeUndefined()
    await expect(
      (await argsFor('open-project', request, worktree, plugin([]))).result
    ).resolves.toBeUndefined()
    const malformed = { ...request, folder: 'x'.repeat(2000) }
    await expect((await argsFor('open-project', malformed)).result).rejects.toThrow(
      'Invalid workspace command request.'
    )
  })

  it('fails when the workspace is not reachable from this computer', async () => {
    const { result } = await argsFor('open-project', { worktreeId: 'gone' }, null)
    await expect(result).rejects.toThrow('This workspace is not available on this computer.')
  })
})

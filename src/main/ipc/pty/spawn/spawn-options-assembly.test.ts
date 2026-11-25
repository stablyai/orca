import { describe, expect, it } from 'vitest'

import { assemblePtySpawnLaunchOptions } from './spawn-options-assembly'

const FOLDER_ID = '7f3c1e2a-5b6d-4c8e-9a0f-1b2c3d4e5f60'

async function workspaceRootFor(
  worktreeId: string | undefined,
  overrides: { connectionId?: string; launchCommand?: string } = {}
): Promise<string | undefined> {
  const { spawnOptions } = await assemblePtySpawnLaunchOptions({
    args: { cols: 80, rows: 24, worktreeId, connectionId: overrides.connectionId },
    env: {},
    envToDelete: [],
    launchCommand: 'launchCommand' in overrides ? overrides.launchCommand : 'claude',
    cwd: '/',
    isDaemonHostSpawn: true,
    preAdoptedStablePane: false,
    isNewSession: true,
    codexRuntime: 'host',
    expectedWslDistro: null,
    requestedAgentTeamsPath: undefined,
    selectedCodexHomePath: null,
    shellOverride: undefined,
    paneKey: undefined,
    sessionId: undefined,
    spawnIntent: undefined,
    historyIsolationEnabled: true,
    store: {
      getFolderWorkspace: (id) => (id === FOLDER_ID ? { folderPath: '/' } : undefined)
    },
    claudeAuth: null
  })
  return spawnOptions.workspaceRoot
}

describe('assemblePtySpawnLaunchOptions workspace root', () => {
  it('resolves a folder workspace root from the stored folder path', async () => {
    expect(await workspaceRootFor(`folder:${FOLDER_ID}`)).toBe('/')
  })

  it('resolves a git workspace root from its worktree id', async () => {
    expect(await workspaceRootFor('repo-1::/')).toBe('/')
  })

  it('leaves the root unset for an unknown folder, a floating terminal or no workspace', async () => {
    expect(await workspaceRootFor('folder:unknown')).toBeUndefined()
    expect(await workspaceRootFor('global-floating-terminal')).toBeUndefined()
    expect(await workspaceRootFor(undefined)).toBeUndefined()
  })

  it('leaves the root unset for a plain shell or a remote spawn', async () => {
    expect(await workspaceRootFor(`folder:${FOLDER_ID}`, { launchCommand: undefined })).toBe(
      undefined
    )
    expect(await workspaceRootFor(`folder:${FOLDER_ID}`, { connectionId: 'ssh-1' })).toBe(undefined)
  })
})

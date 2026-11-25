// A shared agent's home opens on its chat: making it on Accept must start no terminal in its folder.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import { prepareGroupFolderCreation } from '../../runtime/workspaces/creation/runtime-group-folder-setup'
import { memorySharedBotHomes } from './shared-bot-home.test-fixture'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('makes a shared agent’s home without starting a terminal in it', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'shared-home-surface-'))
  dirs.push(userData)
  const { homes, groups, folders } = memorySharedBotHomes(userData)
  await homes.make({ shareId: 'share-1', botName: 'Ivy' })
  const [{ id, ...input }] = folders
  const workspace = {
    id,
    name: input.name,
    folderPath: input.folderPath,
    projectGroupId: input.projectGroupId,
    connectionId: null
  } as unknown as FolderWorkspace
  const createTerminal = vi.fn()
  const provision = vi.fn(async () => ({ setupSpawned: false, setupTerminalHandle: null }))

  await prepareGroupFolderCreation({
    input,
    group: groups[0],
    workspace,
    settings: { disabledTuiAgents: [] } as never,
    ports: {
      canSpawn: true,
      createTerminal,
      provision,
      pasteDraft: vi.fn(),
      sendFollowup: vi.fn(),
      activate: vi.fn()
    },
    startupBuilders: {} as never,
    wait: async () => ({ exitCode: 0 })
  })

  expect(createTerminal).not.toHaveBeenCalled()
  expect(provision).not.toHaveBeenCalled()
})

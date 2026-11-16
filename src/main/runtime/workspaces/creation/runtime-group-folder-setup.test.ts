import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { getDefaultRepoHookSettings, getDefaultSettings } from '../../../../shared/constants'
import { createProjectGroup } from '../../../../shared/project/groups/project-groups'
import type { ProjectGroup } from '../../../../shared/project/groups/project-group-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { FolderWorkspaceCreateInput } from '../../../../shared/folder-workspaces/folder-workspace-create'
import { removeFolderSetupRunnerFiles } from '../../../workspace-hooks/folder-setup-runner-files'
import { prepareGroupFolderCreation } from './runtime-group-folder-setup'
import './runtime-group-folder-setup-host'
import { provisionWorktreeTerminals } from '../startup/runtime-worktree-terminal-provisioning'
import type { RuntimeLocalWorktreeTerminalPorts } from '../startup/runtime-local-worktree-terminal-startup'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../startup/workspace-terminal-provisioning', () => ({
  OrcaRuntimeWithGetWorktreeTerminalProvisioningHost: class {}
}))

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-group-setup-')))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

function fixture(input: Partial<FolderWorkspaceCreateInput> = {}) {
  const group: ProjectGroup = {
    ...createProjectGroup({
      name: 'Services',
      parentPath: root,
      createdFrom: 'folder-scan',
      tabOrder: 0
    }),
    id: 'services',
    hookSettings: {
      ...getDefaultRepoHookSettings(),
      scripts: {
        setup:
          'printf "%s|%s|%s|%s" "$PWD" "$ORCA_ROOT_PATH" "$ORCA_WORKSPACE_ID" "$ORCA_WORKSPACE_NAME" > "$ORCA_ROOT_PATH/ran"',
        archive: ''
      },
      setupRunPolicy: 'run-by-default',
      setupAgentStartupPolicy: 'wait-for-setup',
      commandSourcePolicy: 'local-only'
    }
  }
  const workspace: FolderWorkspace = {
    id: 'task-a',
    projectGroupId: group.id,
    name: 'Repair API',
    folderPath: join(root, 'other'),
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
  const createTerminal = vi.fn(async () => ({
    handle: 'setup-handle',
    ptyId: 'setup-pty',
    worktreeId: 'folder:task-a',
    title: 'Setup'
  }))
  const ports: RuntimeLocalWorktreeTerminalPorts = {
    canSpawn: true,
    createTerminal,
    pasteDraft: vi.fn(),
    sendFollowup: vi.fn(),
    activate: vi.fn(),
    provision: (args) =>
      provisionWorktreeTerminals(
        {
          canSpawn: () => true,
          createTerminal,
          setTabTitle: async () => {},
          setTabColor: async () => {},
          getPtyId: () => 'setup-pty',
          recordSetupCompletionToken: vi.fn()
        },
        args
      )
  }
  const buildStartup = vi.fn()
  const wait = vi.fn(async (): Promise<{ exitCode: number | null }> => ({ exitCode: 0 }))
  const args = {
    input: { projectGroupId: group.id, ...input },
    group,
    workspace,
    settings: getDefaultSettings(root),
    ports,
    startupBuilders: { agent: buildStartup, draft: vi.fn() },
    wait
  }
  return { args, createTerminal, buildStartup, wait }
}

describe('group folder setup lifecycle', () => {
  it.skipIf(process.platform === 'win32')(
    'uses the group root and folder identity and isolates sibling runner lifetimes',
    async () => {
      const { args } = fixture()
      const first = await prepareGroupFolderCreation({
        ...args,
        input: { ...args.input, rendererOwnsSetup: true }
      })
      const second = await prepareGroupFolderCreation({
        ...args,
        workspace: { ...args.workspace, id: 'task-b' },
        input: { ...args.input, rendererOwnsSetup: true }
      })
      expect(first.setup?.cwd).toBe(root)
      expect(first.setup?.envVars).toMatchObject({
        ORCA_WORKSPACE_ID: 'folder:task-a',
        ORCA_WORKTREE_ID: 'folder:task-a',
        ORCA_WORKSPACE_NAME: 'Repair API',
        ORCA_WORKTREE_PATH: join(root, 'other')
      })
      if (!first.setup || !second.setup) {
        throw new Error('Expected prepared setup runners')
      }
      expect(dirname(first.setup.runnerScriptPath)).not.toBe(dirname(second.setup.runnerScriptPath))
      runProcessSync({
        program: 'bash',
        args: [first.setup.runnerScriptPath],
        cwd: first.setup.cwd,
        env: { ...process.env, ...first.setup.envVars }
      })
      expect(readFileSync(join(root, 'ran'), 'utf8')).toBe(
        `${root}|${root}|folder:task-a|Repair API`
      )
      await removeFolderSetupRunnerFiles(root, 'folder:task-a')
      runProcessSync({
        program: 'bash',
        args: [second.setup.runnerScriptPath],
        cwd: second.setup.cwd,
        env: { ...process.env, ...second.setup.envVars }
      })
      expect(readFileSync(join(root, 'ran'), 'utf8')).toBe(
        `${root}|${root}|folder:task-b|Repair API`
      )
    }
  )

  it('waits for structured Setup through the worktree completion observer', async () => {
    const { args, wait, createTerminal, buildStartup } = fixture({ agentLaunchMode: 'structured' })
    let complete: ((value: { exitCode: number | null }) => void) | undefined
    wait.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const creating = prepareGroupFolderCreation(args)
    await vi.waitFor(() => expect(wait).toHaveBeenCalled())
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(createTerminal.mock.calls[0]).toMatchObject([
      'id:folder:task-a',
      { title: 'Setup', cwd: root }
    ])
    expect(buildStartup).not.toHaveBeenCalled()
    let settled = false
    void creating.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    complete?.({ exitCode: 0 })
    expect(await creating).toMatchObject({
      folderWorkspace: { id: 'task-a' }
    })
  })
})

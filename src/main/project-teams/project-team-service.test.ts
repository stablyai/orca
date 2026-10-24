import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ProjectTeam,
  readTeamResource,
  loadTeamResource,
  TeamRegistry
} from './project-team-config'
import { ProjectTeamService } from './project-team-service'
import { allocateTerminalPaneIdentity } from '../runtime/runtime-terminal-pane-identity'

const TAB_ID = 'c180be61-886e-48b3-8c22-642d3553b099'
const LEAF_ID = 'afc85d49-fb91-4b95-ac68-9ea1f8440e12'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-portable-team-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const role = {
  id: 'lead',
  title: '主工程師',
  provider: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'medium',
  cwd: '.',
  instructions: ['role.md']
}
it('returns the exact validated path without expanding a literal tilde', async () => {
  await mkdir(join(root, '~'))
  const settings = join(root, '~', 'settings.json')
  await writeFile(settings, '{}')
  expect(await loadTeamResource(join(root, 'team.json'), '~/settings.json')).toEqual({
    path: await realpath(settings),
    text: '{}'
  })
})
async function fixture() {
  const config = join(root, 'team.json')
  await writeFile(config, JSON.stringify({ version: 1, name: 'Test', roles: [role] }))
  await writeFile(join(root, 'role.md'), 'Role and skills: {{projectRoot}}')
  const tabs: {
    parentTabId: string
    customTitle: string
    terminal?: string
    launchAgent?: string
    leafId?: string
  }[] = []
  const call = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'terminal.inspectProcess') {
      if (typeof params.terminal !== 'string' || !params.terminal) {
        throw new Error('Missing terminal handle')
      }
      return { process: { foregroundProcess: 'codex', hasChildProcesses: true } }
    }
    if (method === 'terminal.isRunningAgent') {
      if (typeof params.terminal !== 'string' || !params.terminal) {
        throw new Error('Missing terminal handle')
      }
      return { isRunningAgent: true }
    }
    if (method === 'session.tabs.list') {
      return { tabs }
    }
    if (method === 'terminal.create') {
      const target = typeof params.tabId === 'string' ? params.tabId : 'new-tab'
      const index = tabs.findIndex((tab) => tab.parentTabId === target)
      if (index !== -1) {
        tabs.splice(index, 1)
      }
      tabs.push({
        parentTabId: target,
        customTitle: role.title,
        launchAgent: role.provider,
        terminal: 'term_new'
      })
      return { terminal: { handle: 'term_new', tabId: target } }
    }
    return {}
  })
  const prepareLaunch = vi.fn(async () => ({
    cwd: root,
    env: {},
    shell: undefined,
    command: 'codex',
    launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
  }))
  const service = new ProjectTeamService({
    call,
    profile: root,
    prepareLaunch,
    workspaces: async () => [{ id: 'NEW-PC-WORKSPACE', path: root, hostId: 'local' }]
  })
  return {
    service,
    binding: { config, projectRoot: root, enabled: true },
    tabs,
    call,
    prepareLaunch
  }
}
describe('portable project teams', () => {
  it('loads source files, resolves current workspace, and starts once across repeated reads', async () => {
    const f = await fixture()
    expect((await f.service.ensure(f.binding))[0].status).toBe('started')
    expect((await f.service.ensure(f.binding))[0].status).toBe('present')
    expect(f.call.mock.calls.filter(([m]) => m === 'terminal.create')).toHaveLength(1)
    expect(f.call.mock.calls.find(([m]) => m === 'terminal.create')?.[1]).toMatchObject({
      worktree: 'id:NEW-PC-WORKSPACE',
      launchAgent: 'codex',
      focus: false,
      activate: false
    })
    const contextFile = f.prepareLaunch.mock.calls[0]
    expect(contextFile).toBeDefined()
  })
  it('coalesces concurrent configuration reads', async () => {
    const f = await fixture()
    await Promise.all([f.service.ensure(f.binding), f.service.ensure(f.binding)])
    expect(f.call.mock.calls.filter(([m]) => m === 'terminal.create')).toHaveLength(1)
  })
  it('does not start disabled teams', async () => {
    const f = await fixture()
    expect(await f.service.ensure({ ...f.binding, enabled: false })).toEqual([])
    expect(f.call).not.toHaveBeenCalled()
  })
  it('preserves existing roles and does not replace an unproven shell', async () => {
    const f = await fixture()
    f.tabs.push({
      parentTabId: TAB_ID,
      leafId: LEAF_ID,
      customTitle: role.title,
      terminal: 'term_old',
      launchAgent: 'codex'
    })
    const base = f.call.getMockImplementation()!
    f.call.mockImplementation(async (method, params) => {
      if (method === 'terminal.inspectProcess') {
        return { process: { foregroundProcess: 'codex', hasChildProcesses: true } }
      }
      if (method === 'terminal.isRunningAgent') {
        return { isRunningAgent: false }
      }
      if (method === 'terminal.inspectProcess') {
        return { process: { foregroundProcess: 'pwsh.exe', hasChildProcesses: true } }
      }
      return base(method, params)
    })
    expect((await f.service.ensure(f.binding))[0]).toMatchObject({
      status: 'blocked',
      code: 'team_existing_role_requires_attention'
    })
    expect(f.prepareLaunch).not.toHaveBeenCalled()
  })
  it('rejects missing skills instead of claiming a role initialized', async () => {
    const f = await fixture()
    await rm(join(root, 'role.md'))
    expect((await f.service.ensure(f.binding))[0].status).toBe('blocked')
    expect(f.prepareLaunch).not.toHaveBeenCalled()
  })
  it('reuses mutation identity after a lost launch reply', async () => {
    const f = await fixture()
    const ids: unknown[] = []
    f.call.mockImplementation(async (m, p) => {
      if (m === 'session.tabs.list') {
        return { tabs: [] }
      }
      if (m === 'terminal.create') {
        ids.push(p.clientMutationId)
        throw new Error('connection_lost')
      }
      return {}
    })
    await f.service.ensure(f.binding)
    await f.service.ensure(f.binding)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
  })
  it('rejects invalid effort, duplicate roles, unknown options and source traversal', async () => {
    expect(ProjectTeam.safeParse({ version: 1, name: 'test', roles: [role, role] }).success).toBe(
      false
    )
    expect(
      ProjectTeam.safeParse({ version: 1, name: 'test', roles: [{ ...role, effort: 'typo' }] })
        .success
    ).toBe(false)
    expect(
      ProjectTeam.safeParse({ version: 1, name: 'test', roles: [{ ...role, command: 'anything' }] })
        .success
    ).toBe(false)
    const outside = join(root, '..', `outside-${Date.now()}.md`)
    await writeFile(outside, 'outside')
    try {
      await expect(readTeamResource(join(root, 'team.json'), outside)).rejects.toThrow(
        'team_resource_outside_config'
      )
    } finally {
      await rm(outside)
    }
  })
  it('requires explicit imported project bindings', () => {
    expect(TeamRegistry.parse({ version: 1, teams: [] }).teams).toEqual([])
    expect(TeamRegistry.safeParse({ version: 1, teams: [{ config: 'team.json' }] }).success).toBe(
      false
    )
  })

  it('wakes a saved role before an empty live inventory can start a duplicate', async () => {
    const f = await fixture()
    const call = vi.fn(
      async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        if (method === 'terminal.create') {
          const identity = allocateTerminalPaneIdentity({
            tabId: typeof params.tabId === 'string' ? params.tabId : undefined,
            leafId: typeof params.leafId === 'string' ? params.leafId : undefined
          })
          expect(identity.tabId).toBe(TAB_ID)
          expect(identity.leafId).toBe(LEAF_ID)
          f.tabs.push({
            parentTabId: TAB_ID,
            customTitle: role.title,
            terminal: 'term_saved',
            launchAgent: 'codex'
          })
          return { terminal: { handle: 'term_saved', tabId: TAB_ID } }
        }
        if (method === 'terminal.inspectProcess') {
          return { process: { foregroundProcess: 'codex', hasChildProcesses: true } }
        }
        if (method === 'terminal.isRunningAgent') {
          return { isRunningAgent: true }
        }
        if (method === 'session.tabs.list') {
          return { tabs: f.tabs }
        }
        return {}
      }
    )
    const service = new ProjectTeamService({
      call,
      profile: root,
      prepareLaunch: f.prepareLaunch,
      existingTabs: () => [{ id: TAB_ID, leafId: LEAF_ID, customTitle: role.title }],
      workspaces: async () => [{ id: 'NEW-PC-WORKSPACE', path: root, hostId: 'local' }]
    })
    expect((await service.ensure(f.binding))[0]).toMatchObject({
      status: 'present',
      terminal: 'term_saved'
    })
    expect(f.prepareLaunch).not.toHaveBeenCalled()
    expect(call.mock.calls.filter(([m]) => m === 'terminal.create')).toHaveLength(1)
  })

  it('restarts a confirmed empty shell even when cached agent status is stale', async () => {
    const f = await fixture()
    f.tabs.push({
      parentTabId: TAB_ID,
      leafId: LEAF_ID,
      customTitle: role.title,
      terminal: 'term_empty',
      launchAgent: 'codex'
    })
    const base = f.call.getMockImplementation()!
    f.call.mockImplementation(async (method, params) => {
      if (method === 'terminal.isRunningAgent') {
        return { isRunningAgent: true }
      }
      if (method === 'terminal.inspectProcess' && params.terminal === 'term_empty') {
        return { process: { foregroundProcess: 'pwsh.exe', hasChildProcesses: false } }
      }
      if (method === 'terminal.close') {
        // Stopping the PTY leaves the saved role tab available for restoration.
        f.tabs[0].terminal = undefined
        return { close: { ptyKilled: true } }
      }
      return base(method, params)
    })
    expect((await f.service.ensure(f.binding))[0].status).toBe('started')
    const methods = f.call.mock.calls.map(([m]) => m)
    expect(methods.indexOf('terminal.close')).toBeLessThan(methods.indexOf('terminal.create'))
    expect(f.call.mock.calls.find(([m]) => m === 'terminal.create')?.[1]).toMatchObject({
      tabId: TAB_ID,
      leafId: LEAF_ID
    })
    expect(f.tabs).toHaveLength(1)
    expect((await f.service.ensure(f.binding))[0].status).toBe('present')
    expect(f.tabs).toHaveLength(1)
  })
  it.each(['terminal_gone', 'terminal_handle_stale'])(
    'reattaches a restored role in its original tab after %s',
    async (code) => {
      const f = await fixture()
      f.tabs.push({
        parentTabId: TAB_ID,
        leafId: LEAF_ID,
        customTitle: role.title,
        terminal: 'term_stale',
        launchAgent: 'codex'
      })
      const base = f.call.getMockImplementation()!
      f.call.mockImplementation(async (method, params) => {
        if (method === 'terminal.isRunningAgent' && params.terminal === 'term_stale') {
          throw new Error(code)
        }
        return base(method, params)
      })
      expect((await f.service.ensure(f.binding))[0]).toMatchObject({
        status: 'present',
        terminal: 'term_new'
      })
      expect(f.call.mock.calls.find(([m]) => m === 'terminal.create')?.[1]).toMatchObject({
        tabId: TAB_ID,
        leafId: LEAF_ID,
        focus: false,
        activate: false
      })
      expect(f.tabs).toHaveLength(1)
      expect(f.prepareLaunch).not.toHaveBeenCalled()
    }
  )

  it('preserves a role with unverified or active child processes', async () => {
    const f = await fixture()
    f.tabs.push({
      parentTabId: 'unknown',
      customTitle: role.title,
      terminal: 'term_unknown',
      launchAgent: 'codex'
    })
    const base = f.call.getMockImplementation()!
    f.call.mockImplementation(async (method, params) => {
      if (method === 'terminal.isRunningAgent') {
        return { isRunningAgent: false }
      }
      if (method === 'terminal.inspectProcess') {
        return { process: { foregroundProcess: 'pwsh.exe', hasChildProcesses: true } }
      }
      return base(method, params)
    })
    expect((await f.service.ensure(f.binding))[0].status).toBe('blocked')
    expect(f.call.mock.calls.some(([m]) => m === 'terminal.close' || m === 'terminal.create')).toBe(
      false
    )
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeClientModule from '../runtime-client'
import { RuntimeClient } from '../runtime-client'
import { WORKTREE_CROSS_MACHINE_LINEAGE_CAPABILITY } from '../../shared/worktree-runtime-capabilities'

const { localCall, localConstructor } = vi.hoisted(() => ({
  localCall: vi.fn(),
  localConstructor: vi.fn()
}))
vi.mock('../runtime-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeClientModule>()
  return {
    ...actual,
    RuntimeClient: class {
      constructor(...args: unknown[]) {
        localConstructor(...args)
      }
      call = localCall
    }
  }
})
import { WORKTREE_HANDLERS } from './worktree'

function context(capabilities: string[], explicit: boolean) {
  const parent = {
    id: 'repo::/parent',
    instanceId: 'parent-instance',
    hostId: 'local',
    path: '/unmanaged'
  }
  localCall.mockImplementation(async (method, params) => {
    if (method === 'worktree.show' && params.worktree !== `id:${parent.id}`) {
      throw new Error('selector_not_found')
    }
    return { result: method === 'worktree.list' ? { worktrees: [parent] } : { worktree: parent } }
  })
  const call = vi.fn(async (method: string) => ({
    result:
      method === 'status.get'
        ? { capabilities }
        : { worktree: { id: 'repo::/child' }, warnings: [] }
  }))
  const client = Object.assign(new RuntimeClient('/tmp/cml-v3-cli', 60_000, null, null), {
    userDataPath: '/tmp/cml-v3-cli',
    isRemote: true,
    environmentSelector: 'Build server',
    call
  })
  const flags = new Map<string, string | boolean>([
    ['repo', 'id:repo'],
    ['name', 'child']
  ])
  if (explicit) {
    flags.set('parent-worktree', 'active')
  }
  return { context: { flags, client, cwd: '/unmanaged', json: true }, call }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  localCall.mockReset()
  localConstructor.mockClear()
})

describe('caller-side cross-machine create', () => {
  it('keeps explicit target selectors and legacy folder payloads on an older peer', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const selector of [
      'id:repo::/parent',
      'branch:main',
      'name:Parent',
      'path:/mnt/c/server',
      'folder:F'
    ]) {
      const target = context([], false)
      target.context.flags.set('parent-worktree', selector)
      await WORKTREE_HANDLERS['worktree create'](target.context)
      const payload =
        selector === 'folder:F' ? { parentWorkspace: selector } : { parentWorktree: selector }
      expect(target.call).toHaveBeenCalledWith('worktree.create', expect.objectContaining(payload))
      expect(target.call.mock.calls.some(([method]) => method === 'status.get')).toBe(false)
    }
    expect(localCall).not.toHaveBeenCalled()
  })
  it('refuses an explicit parent on an old server before create, and lets an inferred parent create flat with a warning', async () => {
    vi.stubEnv('ORCA_WORKSPACE_ID', 'worktree:repo::/parent')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const explicit = context([], true)
    await expect(WORKTREE_HANDLERS['worktree create'](explicit.context)).rejects.toThrow(
      'Update Orca on Build server'
    )
    expect(explicit.call.mock.calls.map(([method]) => method)).toEqual(['status.get'])
    expect(localConstructor).toHaveBeenCalledWith('/tmp/cml-v3-cli', 60_000, null, null)
    const inferred = context([], false)
    await WORKTREE_HANDLERS['worktree create'](inferred.context)
    expect(inferred.call).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ parentWorktreeRef: undefined, callerTerminalHandle: undefined })
    )
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Creating without a parent'))
  })

  it('sends the caller parent identity to a capable server', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const env of ['ORCA_WORKSPACE_ID', 'ORCA_WORKTREE_ID']) {
      vi.stubEnv(env, env === 'ORCA_WORKSPACE_ID' ? 'worktree:repo::/parent' : 'repo::/parent')
      const capable = context([WORKTREE_CROSS_MACHINE_LINEAGE_CAPABILITY], false)
      await WORKTREE_HANDLERS['worktree create'](capable.context)
      expect(capable.call).toHaveBeenCalledWith(
        'worktree.create',
        expect.objectContaining({
          parentWorktreeRef: {
            worktreeId: 'repo::/parent',
            instanceId: 'parent-instance',
            external: true
          }
        })
      )
      expect(localCall).toHaveBeenCalledWith('worktree.show', { worktree: 'id:repo::/parent' })
      vi.unstubAllEnvs()
    }
  })
})

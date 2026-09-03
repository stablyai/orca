import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildWslGuestTreeKillArgs,
  runWslGuestTreeKill,
  WSL_GUEST_TREE_KILL_TIMEOUT_MS
} from './wsl-guest-tree-kill'
import { ORCA_PTY_TREE_ID_ENV } from '../pty/wsl-orca-env'

let platformDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  if (platformDescriptor) {
    Object.defineProperty(process, 'platform', platformDescriptor)
  }
})

describe('buildWslGuestTreeKillArgs', () => {
  it('hands the token positionally so it never passes through a shell', () => {
    const token = 'worktree@@a1b2c3d4'
    const args = buildWslGuestTreeKillArgs('Ubuntu', token)
    expect(args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--exec', 'sh'])
    // Token rides in argv ($1 in the guest), never interpolated into the script.
    expect(args.at(-1)).toBe(token)
    expect(args.slice(0, -1).join('\n')).not.toContain(token)
  })

  it('keys the guest match on the same marker the spawn stamps', () => {
    const script = buildWslGuestTreeKillArgs('Debian', 'token')[5] as string
    expect(script).toContain(ORCA_PTY_TREE_ID_ENV)
    expect(script).toContain('/proc/')
    expect(script).toContain('TERM')
    expect(script).toContain('KILL')
  })
})

describe('runWslGuestTreeKill', () => {
  it('runs wsl.exe with the default budget and resolves on success', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, timedOut: false })
    await expect(
      runWslGuestTreeKill({ distro: 'Ubuntu', treeId: 'sess@@a1b2c3d4', run })
    ).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledOnce()
    const spec = run.mock.calls[0][0] as { program: string; timeoutMs: number }
    expect(spec.program).toBe('wsl.exe')
    expect(spec.timeoutMs).toBe(WSL_GUEST_TREE_KILL_TIMEOUT_MS)
  })

  it('never rejects when the guest spawn fails or times out', async () => {
    const run = vi.fn().mockRejectedValue(new Error('spawn ENOENT'))
    await expect(
      runWslGuestTreeKill({ distro: 'Ubuntu', treeId: 'sess@@a1b2c3d4', run })
    ).resolves.toBeUndefined()
  })

  it.each([[''], [undefined]])('skips without spawning when the marker is %p', async (treeId) => {
    const run = vi.fn()
    await runWslGuestTreeKill({ distro: 'Ubuntu', treeId: treeId as string, run })
    expect(run).not.toHaveBeenCalled()
  })

  it('skips without spawning when the marker carries control characters', async () => {
    const run = vi.fn()
    await runWslGuestTreeKill({ distro: 'Ubuntu', treeId: 'sess\n@@evil', run })
    expect(run).not.toHaveBeenCalled()
  })

  it('skips without spawning when the distro is missing', async () => {
    const run = vi.fn()
    await runWslGuestTreeKill({ distro: '', treeId: 'sess@@a1b2c3d4', run })
    expect(run).not.toHaveBeenCalled()
  })
})

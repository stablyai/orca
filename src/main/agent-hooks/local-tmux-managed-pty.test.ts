import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLocalHookPaneRootResolver,
  createLocalPtyInventoryReader,
  createLocalTmuxManagedPtyResolver,
  createWslBridgePaneRootReader
} from './local-tmux-managed-pty'
import type { PtyProcessInfo } from '../providers/pty-provider-contract'

const row: PtyProcessInfo = {
  id: 'pty',
  incarnationId: 'generation',
  rootProcessId: 123,
  cwd: '/workspace',
  title: 'shell',
  worktreeId: 'folder:workspace'
}
afterEach(() => {
  vi.useRealTimers()
})

describe.skipIf(process.platform === 'win32')('authenticated local tmux root resolution', () => {
  it('shares inventory captures and accepts only the current daemon binding', async () => {
    const listProcesses = vi.fn(async () => [row])
    const resolve = createLocalTmuxManagedPtyResolver(
      createLocalPtyInventoryReader({ getPtyId: () => 'pty', listProcesses })
    )
    const [first, second] = await Promise.all([resolve('pane'), resolve('pane')])
    expect(first).toEqual({
      pid: 123,
      incarnation: 'generation',
      scope: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder:workspace',
        workspaceKind: 'folder'
      }
    })
    expect(second).toEqual(first)
    expect(listProcesses).toHaveBeenCalledTimes(1)
  })
  it('refuses a binding changed during capture and excludes WSL roots from a native probe', async () => {
    let binding = 'pty'
    const resolve = createLocalTmuxManagedPtyResolver(
      createLocalPtyInventoryReader({
        getPtyId: () => binding,
        listProcesses: async () => {
          binding = 'replacement'
          return [row]
        }
      })
    )
    expect(await resolve('pane')).toBeNull()
    const wsl = createLocalTmuxManagedPtyResolver(
      createLocalPtyInventoryReader({
        getPtyId: () => 'pty',
        listProcesses: async () => [{ ...row, wslDistro: 'Ubuntu-24.04' }]
      })
    )
    expect(await wsl('pane')).toBeNull()
  })
  it('refreshes expired inventory instead of assigning a reused PID to the old incarnation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([{ ...row, incarnationId: 'replacement' }])
    const resolve = createLocalTmuxManagedPtyResolver(
      createLocalPtyInventoryReader({ getPtyId: () => 'pty', listProcesses })
    )
    expect((await resolve('pane'))?.incarnation).toBe('generation')
    vi.setSystemTime(1999)
    expect((await resolve('pane'))?.incarnation).toBe('generation')
    expect(listProcesses).toHaveBeenCalledTimes(1)
    vi.setSystemTime(2000)
    expect((await resolve('pane'))?.incarnation).toBe('replacement')
  })

  it('re-reads a snapshot that predates a pane’s PTY once, not on every miss', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const listProcesses = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([row])
    const resolve = createLocalHookPaneRootResolver(
      createLocalPtyInventoryReader({
        getPtyId: (paneKey) => (paneKey === 'pane' ? 'pty' : 'gone'),
        listProcesses
      })
    )
    expect(await resolve('pane', undefined)).toBeNull()
    vi.setSystemTime(1500)
    // The PTY spawned after the cached snapshot: a cached miss is not an answer.
    expect(await resolve('pane', undefined)).toEqual({ pid: 123, incarnation: 'generation' })
    expect(listProcesses).toHaveBeenCalledTimes(2)
    vi.setSystemTime(1600)
    expect(await resolve('gone', undefined)).toBeNull()
    expect(listProcesses).toHaveBeenCalledTimes(2)
  })

  it('names a hook pane root from the provider, before reattach too, and keeps older PTYs legacy', async () => {
    const rows: PtyProcessInfo[] = [
      { ...row, paneKey: 'restored' },
      { ...row, id: 'old-daemon', incarnationId: undefined, paneKey: 'old' }
    ]
    const binding = new Map([['bound', 'pty']])
    const resolve = createLocalHookPaneRootResolver(
      createLocalPtyInventoryReader({
        getPtyId: (paneKey) => binding.get(paneKey),
        listProcesses: async () => rows
      })
    )
    expect(await resolve('bound', 'folder:workspace')).toEqual({
      pid: 123,
      incarnation: 'generation'
    })
    // A restored pane not yet reattached is still named by the PTY's own spawn record.
    expect(await resolve('restored', undefined)).toEqual({ pid: 123, incarnation: 'generation' })
    expect(await resolve('old', undefined)).toBe('legacy')
    expect(await resolve('bound', 'another-worktree')).toBeNull()
    expect(await resolve('unbound', undefined)).toBeNull()
  })

  it('answers a WSL relay with its distro’s recorded guest root, or its legacy path', async () => {
    const wslGuestRoot = { pid: 4242, startTime: '0b1d2c3e-4f50-4617-8293-a4b5c6d7e8f9:98765' }
    const rows: PtyProcessInfo[] = [
      { ...row, id: 'new', wslDistro: 'Ubuntu', wslGuestRoot },
      { ...row, id: 'old', wslDistro: 'Ubuntu' }
    ]
    const read = createWslBridgePaneRootReader(
      createLocalPtyInventoryReader({
        getPtyId: (paneKey) => paneKey,
        listProcesses: async () => rows
      }),
      (paneKey) => paneKey
    )
    const issue = vi.fn((_pane: string, incarnation: string) => `1/${incarnation}`)
    expect(await read(issue, 'Ubuntu', 'new')).toEqual({
      root: wslGuestRoot,
      incarnation: '1/generation'
    })
    expect(await read(issue, 'Ubuntu', 'old')).toEqual({ legacy: true })
    // Another distro's relay never learns this PTY's root.
    expect(await read(issue, 'Debian', 'new')).toEqual({})
    // Only a returned root binds; a link replaced during the read gets nothing.
    expect(issue).toHaveBeenCalledOnce()
    expect(await read(() => undefined, 'Ubuntu', 'new')).toEqual({})
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLocalHookPaneRootResolver,
  createLocalPtyInventoryReader,
  createLocalTmuxManagedPtyResolver
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
})

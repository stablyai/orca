import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listRegisteredPtysMock } = vi.hoisted(() => ({ listRegisteredPtysMock: vi.fn() }))

vi.mock('../memory/pty-registry', () => ({ listRegisteredPtys: listRegisteredPtysMock }))

import { killAllProcessesForWorktree } from './worktree-teardown'
import { WORKTREE_TEARDOWN_FORCE_HINT } from '../../shared/worktree/removal'
import type { IPtyProvider } from '../providers/types'
import type { PtyProcessSourceListing } from '../providers/pty-process-source-listing'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { listDaemonProcessesBySource } from '../daemon/daemon-generation-listing'

const WORKTREE = 'repo::/tmp/wt'

/** Current version answers with `current`; version 35 is silent and was last known to hold `silent`. */
function providerWithSilentVersion(current: string[], silent: string[]): IPtyProvider {
  const listings: PtyProcessSourceListing[] = [
    {
      protocolVersion: 36,
      isCurrent: true,
      contact: 'live',
      processes: current.map((id) => ({ id, cwd: '', title: 'shell' }))
    },
    {
      protocolVersion: 35,
      isCurrent: false,
      contact: 'unverifiable',
      error: new Error('Request listSessions timed out'),
      lastKnownIds: silent
    }
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown reads only these provider members.
  return {
    listProcessesBySource: vi.fn(async () => listings),
    listProcesses: vi.fn(async () => {
      throw new Error('Request listSessions timed out')
    }),
    // Why: the silent version never answers its stop; the current one does.
    shutdown: vi.fn(async (id: string) => {
      if (!current.includes(id)) {
        throw new Error('Request kill timed out')
      }
    }),
    confirmPtyStopped: vi.fn(async (id: string) => (current.includes(id) ? true : null)),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {})
  } as unknown as IPtyProvider
}

describe('workspace delete while a terminal-service version does not answer', () => {
  beforeEach(() => {
    listRegisteredPtysMock.mockReset().mockReturnValue([])
  })

  it('deletes and reports the unchecked version when it held no known terminal here', async () => {
    const provider = providerWithSilentVersion([`${WORKTREE}@@a`], ['repo::/tmp/other@@b'])

    const result = await killAllProcessesForWorktree(WORKTREE, {
      localProvider: provider,
      requirePhysicalStop: true,
      timeoutMs: 1_000
    })

    expect(result.providerStopped).toBe(1)
    expect(result.uncheckedTerminalServices).toEqual([{ protocolVersion: 35 }])
    expect(provider.shutdown).not.toHaveBeenCalledWith('repo::/tmp/other@@b', expect.anything())
  })

  it('refuses with the Force Delete hint when the silent version held a terminal of this workspace', async () => {
    const provider = providerWithSilentVersion([`${WORKTREE}@@a`], [`${WORKTREE}@@old`])

    await expect(
      killAllProcessesForWorktree(WORKTREE, {
        localProvider: provider,
        requirePhysicalStop: true,
        timeoutMs: 1_000
      })
    ).rejects.toThrow(WORKTREE_TEARDOWN_FORCE_HINT)
    expect(provider.shutdown).toHaveBeenCalledWith(`${WORKTREE}@@old`, expect.anything())
    // The listing already found its owner silent, so the verdict does not wait on it again.
    expect(provider.confirmPtyStopped).not.toHaveBeenCalledWith(
      `${WORKTREE}@@old`,
      expect.anything()
    )
  })

  it('refuses when a saved tab of this workspace is bound to an id no answered version listed', async () => {
    const provider = providerWithSilentVersion([`${WORKTREE}@@a`], [])

    await expect(
      killAllProcessesForWorktree(WORKTREE, {
        localProvider: provider,
        requirePhysicalStop: true,
        timeoutMs: 1_000,
        persistedPaneSessionIds: [`${WORKTREE}@@a`, 'restored-owner-unverified']
      })
    ).rejects.toThrow(WORKTREE_TEARDOWN_FORCE_HINT)
    expect(provider.shutdown).toHaveBeenCalledWith('restored-owner-unverified', expect.anything())
  })

  it('does not count a saved binding the answering version already listed', async () => {
    const provider = providerWithSilentVersion([`${WORKTREE}@@a`], [])

    const result = await killAllProcessesForWorktree(WORKTREE, {
      localProvider: provider,
      requirePhysicalStop: true,
      timeoutMs: 1_000,
      persistedPaneSessionIds: [`${WORKTREE}@@a`]
    })

    expect(result.uncheckedTerminalServices).toEqual([{ protocolVersion: 35 }])
  })

  it('still stops a session of a current version that lists slower than the cap', async () => {
    const orphan = `${WORKTREE}@@orphan`
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listing reads only these adapter members.
    const current = {
      protocolVersion: 36,
      readProcesses: () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ contact: 'live', items: [{ id: orphan, cwd: '', title: 'shell' }] }),
            3_500
          )
        ),
      getActiveSessionIds: () => []
    } as unknown as DaemonPtyAdapter
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listing reads only these adapter members.
    const frozen = {
      protocolVersion: 35,
      readProcesses: () => new Promise(() => {}),
      getActiveSessionIds: () => []
    } as unknown as DaemonPtyAdapter
    const shutdown = vi.fn(async () => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown reads only these provider members.
    const provider = {
      listProcessesBySource: (opts?: { deadlineMs?: number; nonCurrentDeadlineMs?: number }) =>
        listDaemonProcessesBySource({ adapters: [current, frozen], current }, new Map(), opts),
      shutdown,
      confirmPtyStopped: vi.fn(async () => true),
      listProcesses: vi.fn(async () => []),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {})
    } as unknown as IPtyProvider

    const result = await killAllProcessesForWorktree(WORKTREE, {
      localProvider: provider,
      requirePhysicalStop: true,
      timeoutMs: 7_000
    })

    expect(shutdown).toHaveBeenCalledWith(orphan, expect.anything())
    expect(result.providerStopped).toBe(1)
    expect(result.uncheckedTerminalServices).toEqual([{ protocolVersion: 35 }])
  }, 15_000)

  it('lets an explicit Force Delete through past that terminal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = providerWithSilentVersion([], [`${WORKTREE}@@old`])

    const result = await killAllProcessesForWorktree(WORKTREE, {
      localProvider: provider,
      requirePhysicalStop: true,
      allowUnverifiedStop: true,
      timeoutMs: 1_000
    })

    expect(result.providerStopped).toBe(0)
    warn.mockRestore()
  })
})

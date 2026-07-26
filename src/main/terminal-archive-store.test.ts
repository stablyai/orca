import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArchivedTerminalTab } from '../shared/terminal-archive-types'
import type { TerminalArchiveSnapshotSource } from '../shared/workspace-session-terminal-archive'
import { TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT } from '../shared/terminal-scrollback-limits'
import { TerminalArchiveStore, type TerminalArchiveRepository } from './terminal-archive-store'
import type { ArchiveTerminalTabRequest } from './terminal-archive-contracts'
import { readTerminalScrollbackSnapshotSync } from './terminal-scrollback-snapshots'

const testState = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({ app: { getPath: () => testState.root } }))

const WORKTREE_ID = 'repo-1::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

function request(overrides: Partial<ArchiveTerminalTabRequest> = {}): ArchiveTerminalTabRequest {
  return {
    operationId: 'close-intent-1',
    sourceTabId: 'tab-1',
    executionHostId: 'local',
    worktreeId: WORKTREE_ID,
    title: 'Terminal',
    layout: {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null
    },
    panesByLeafId: {
      [LEAF_ID]: {
        archivedLeafId: LEAF_ID,
        cwd: '/worktree',
        startupCommand: 'token-like-command-must-not-be-logged'
      }
    },
    sourcePaneIdentityByLeafId: {
      [LEAF_ID]: { paneKey: `tab-1:${LEAF_ID}`, incarnationId: 'original-incarnation' }
    },
    reason: 'user-close',
    ...overrides
  }
}

function repository(options: { failFlush?: boolean } = {}): {
  value: TerminalArchiveRepository
  archives: Record<string, ArchivedTerminalTab>
} {
  let archives: Record<string, ArchivedTerminalTab> = {}
  const storage = { snapshotRoot: join(testState.root, 'terminal-scrollback') }
  return {
    get archives() {
      return archives
    },
    value: {
      getTerminalArchives: () => ({ ...archives }),
      replaceTerminalArchivesAndFlush: (next) => {
        if (options.failFlush) {
          throw new Error('disk unavailable')
        }
        archives = { ...next }
      },
      getTerminalArchiveRetentionDays: () => 7,
      isExecutionHostReachable: (hostId) => hostId === 'local',
      worktreeExists: (worktreeId, hostId) => worktreeId === WORKTREE_ID && hostId === 'local',
      // This fixture explicitly authorizes only its local test worktree; rejection has dedicated cases below.
      isTerminalArchiveRequestOwned: (archiveRequest) =>
        archiveRequest.executionHostId === 'local' &&
        archiveRequest.worktreeId === WORKTREE_ID &&
        archiveRequest.sourceTabId === 'tab-1',
      isTerminalScrollbackSnapshotLive: (ref) =>
        Object.values(archives).some((archive) =>
          Object.values(archive.panesByLeafId).some((pane) => pane.snapshot?.ref === ref)
        ),
      terminalScrollbackSnapshotStorage: storage
    }
  }
}

function source(buffer = 'snapshot'): TerminalArchiveSnapshotSource {
  return {
    capture: vi.fn(async () => ({
      kind: 'captured-bytes' as const,
      buffer,
      source: 'renderer' as const,
      truncated: false,
      byteLength: Buffer.byteLength(buffer)
    }))
  }
}

describe('TerminalArchiveStore', () => {
  beforeEach(() => {
    testState.root = mkdtempSync(join(tmpdir(), 'orca-terminal-archive-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.root, { recursive: true, force: true })
  })

  it('writes archive metadata atomically and de-duplicates the close operation', async () => {
    const repo = repository()
    const snapshotSource = source()
    const store = new TerminalArchiveStore(repo.value, snapshotSource, () => 100)

    const first = await store.archiveTerminalTab(request())
    const retried = await store.archiveTerminalTab(request())

    expect(retried.id).toBe(first.id)
    expect(Object.keys(repo.archives)).toEqual([first.id])
    expect(snapshotSource.capture).toHaveBeenCalledTimes(2)
    expect(first.panesByLeafId[LEAF_ID]?.snapshot?.ref).toMatch(/^v1a-[0-9a-f]{32}$/)
  })

  it('uses the store clock instead of a request timestamp for pruning and expiry', async () => {
    let currentTime = 100
    const repo = repository()
    const store = new TerminalArchiveStore(repo.value, source(), () => currentTime)
    const first = await store.archiveTerminalTab(request())

    currentTime = 200
    const second = await store.archiveTerminalTab(
      request({ operationId: 'close-intent-2', archivedAt: RETENTION_MS * 2 })
    )

    expect(repo.archives[first.id]).toBeDefined()
    expect(second.archivedAt).toBe(currentTime)
    expect(second.expiresAt).toBe(currentTime + RETENTION_MS)
  })

  it('does not make a successful archive immediately expired from a stale request timestamp', async () => {
    const currentTime = RETENTION_MS * 2
    const repo = repository()
    const store = new TerminalArchiveStore(repo.value, source(), () => currentTime)

    const archive = await store.archiveTerminalTab(request({ archivedAt: 0 }))

    expect(archive.archivedAt).toBe(currentTime)
    expect(archive.expiresAt).toBe(currentTime + RETENTION_MS)
    expect(repo.archives[archive.id]).toBeDefined()
  })

  it('recaptures and replaces the same archive record when a durable close retry has new output', async () => {
    const repo = repository()
    const snapshotSource: TerminalArchiveSnapshotSource = {
      capture: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'captured-bytes',
          buffer: 'before retirement failed',
          source: 'renderer',
          truncated: false,
          byteLength: 24
        })
        .mockResolvedValueOnce({
          kind: 'captured-bytes',
          buffer: 'after retry captured output',
          source: 'renderer',
          truncated: false,
          byteLength: 27
        })
    }
    const store = new TerminalArchiveStore(repo.value, snapshotSource, () => 100)

    const first = await store.archiveTerminalTab(request())
    const retried = await store.archiveTerminalTab(request())
    const snapshot = retried.panesByLeafId[LEAF_ID]?.snapshot

    expect(retried.id).toBe(first.id)
    expect(Object.keys(repo.archives)).toEqual([first.id])
    expect(retried.sourcePaneSignature).toMatch(/^[0-9a-f]{64}$/)
    expect(snapshotSource.capture).toHaveBeenCalledTimes(2)
    expect(snapshot?.ref).not.toBe(first.panesByLeafId[LEAF_ID]?.snapshot?.ref)
    expect(
      snapshot &&
        readTerminalScrollbackSnapshotSync(
          snapshot.ref,
          repo.value.terminalScrollbackSnapshotStorage
        )
    ).toBe('after retry captured output')
  })

  it('rejects a retry whose source pane incarnation changed', async () => {
    const repo = repository()
    const snapshotSource = source()
    const store = new TerminalArchiveStore(repo.value, snapshotSource, () => 100)

    await store.archiveTerminalTab(request())

    await expect(
      store.archiveTerminalTab(
        request({
          sourcePaneIdentityByLeafId: {
            [LEAF_ID]: { paneKey: `tab-1:${LEAF_ID}`, incarnationId: 'replacement-incarnation' }
          }
        })
      )
    ).rejects.toMatchObject({ code: 'stale-source' })
    expect(snapshotSource.capture).toHaveBeenCalledTimes(1)
  })

  it('fails the archive when every snapshot source is unavailable', async () => {
    const repo = repository()
    const snapshotSource: TerminalArchiveSnapshotSource = {
      capture: async () => ({ kind: 'unavailable' })
    }
    const store = new TerminalArchiveStore(repo.value, snapshotSource)

    await expect(store.archiveTerminalTab(request())).rejects.toMatchObject({
      code: 'capture-unavailable'
    })
    expect(repo.archives).toEqual({})
  })

  it('rejects an unowned host/worktree/PTY request before sidecar capture', async () => {
    const repo = repository()
    const snapshotSource = source()
    repo.value.isTerminalArchiveRequestOwned = vi.fn(() => false)
    const store = new TerminalArchiveStore(repo.value, snapshotSource)

    await expect(store.archiveTerminalTab(request())).rejects.toMatchObject({ code: 'not-owned' })

    expect(snapshotSource.capture).not.toHaveBeenCalled()
    expect(repo.archives).toEqual({})
    expect(existsSync(join(testState.root, 'terminal-scrollback'))).toBe(false)
  })

  it('rechecks ownership after capture and rolls back staged sidecars on a topology CAS loss', async () => {
    const repo = repository()
    const ownership = vi
      .fn<
        (
          request: Parameters<TerminalArchiveRepository['isTerminalArchiveRequestOwned']>[0]
        ) => boolean
      >()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    repo.value.isTerminalArchiveRequestOwned = ownership
    const snapshotSource = source()
    const store = new TerminalArchiveStore(repo.value, snapshotSource)

    await expect(store.archiveTerminalTab(request())).rejects.toMatchObject({ code: 'not-owned' })

    expect(ownership).toHaveBeenCalledTimes(2)
    expect(snapshotSource.capture).toHaveBeenCalledTimes(1)
    expect(repo.archives).toEqual({})
    expect(readdirSync(join(testState.root, 'terminal-scrollback'))).toEqual([])
  })

  it('archives a known-empty terminal without writing a sidecar', async () => {
    const repo = repository()
    const snapshotSource: TerminalArchiveSnapshotSource = {
      capture: async () => ({ kind: 'captured-empty' })
    }
    const store = new TerminalArchiveStore(repo.value, snapshotSource)

    const archive = await store.archiveTerminalTab(request())

    expect(archive.panesByLeafId[LEAF_ID]?.snapshot).toBeUndefined()
    expect(repo.archives[archive.id]).toBeDefined()
    expect(existsSync(join(testState.root, 'terminal-scrollback'))).toBe(false)
  })

  it('removes already-written sidecars when a later pane capture fails', async () => {
    const repo = repository()
    const secondLeaf = '22222222-2222-4222-8222-222222222222'
    const snapshotSource: TerminalArchiveSnapshotSource = {
      capture: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'captured-bytes',
          buffer: 'first',
          source: 'renderer',
          truncated: false,
          byteLength: 5
        })
        .mockRejectedValueOnce(new Error('second capture failed'))
    }
    const store = new TerminalArchiveStore(repo.value, snapshotSource)

    await expect(
      store.archiveTerminalTab(
        request({
          panesByLeafId: {
            [LEAF_ID]: { archivedLeafId: LEAF_ID, cwd: '/worktree' },
            [secondLeaf]: { archivedLeafId: secondLeaf, cwd: '/worktree' }
          },
          sourcePaneIdentityByLeafId: {
            [LEAF_ID]: { paneKey: `tab-1:${LEAF_ID}`, incarnationId: 'original-incarnation' },
            [secondLeaf]: { paneKey: `tab-1:${secondLeaf}`, incarnationId: 'second-incarnation' }
          }
        })
      )
    ).rejects.toThrow('second capture failed')

    expect(repo.archives).toEqual({})
    expect(existsSync(join(testState.root, 'terminal-scrollback'))).toBe(true)
    expect(readdirSync(join(testState.root, 'terminal-scrollback'))).toEqual([])
  })

  it('does not retain sidecars when the metadata flush fails', async () => {
    const repo = repository({ failFlush: true })
    const store = new TerminalArchiveStore(repo.value, source())

    await expect(store.archiveTerminalTab(request())).rejects.toThrow('disk unavailable')

    expect(repo.archives).toEqual({})
    expect(readdirSync(join(testState.root, 'terminal-scrollback'))).toEqual([])
  })

  it('caps a UTF-8 snapshot at the replay limit without logging the command', async () => {
    const repo = repository()
    const warn = vi.spyOn(console, 'warn')
    const log = vi.spyOn(console, 'log')
    const store = new TerminalArchiveStore(repo.value, source('🦊'.repeat(200_000)))

    const archive = await store.archiveTerminalTab(request())
    const snapshot = archive.panesByLeafId[LEAF_ID]?.snapshot
    const replay = snapshot
      ? readTerminalScrollbackSnapshotSync(
          snapshot.ref,
          repo.value.terminalScrollbackSnapshotStorage
        )
      : null

    expect(snapshot?.byteLength).toBeLessThanOrEqual(TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT)
    expect(snapshot?.truncated).toBe(true)
    expect(replay?.endsWith('🦊')).toBe(true)
    expect(`${warn.mock.calls}${log.mock.calls}`).not.toContain(
      'token-like-command-must-not-be-logged'
    )
    warn.mockRestore()
    log.mockRestore()
  })

  it('keeps host and worktree validation errors stable before restore is implemented', async () => {
    const repo = repository()
    const store = new TerminalArchiveStore(repo.value, source(), () => 100)
    const archive = await store.archiveTerminalTab(request())

    await expect(
      store.restoreTerminalArchive(archive.id, { executionHostId: 'ssh:other' })
    ).resolves.toEqual({
      ok: false,
      code: 'archive_host_mismatch',
      archiveId: archive.id
    })
    await expect(store.restoreTerminalArchive(archive.id)).resolves.toEqual({
      ok: false,
      code: 'not_implemented',
      archiveId: archive.id
    })
    repo.value.worktreeExists = () => false
    await expect(store.restoreTerminalArchive(archive.id)).resolves.toEqual({
      ok: false,
      code: 'archive_worktree_missing',
      archiveId: archive.id
    })
  })

  it('flushes expired metadata before deleting an unreferenced archive sidecar', async () => {
    const repo = repository()
    const store = new TerminalArchiveStore(repo.value, source(), () => 0)
    const archive = await store.archiveTerminalTab(request())
    const ref = archive.panesByLeafId[LEAF_ID]?.snapshot?.ref

    const result = await store.pruneExpiredTerminalArchives(7 * 24 * 60 * 60 * 1_000)

    expect(result.prunedIds).toEqual([archive.id])
    expect(ref && result.deletedSnapshotRefs).toContain(ref)
    expect(repo.archives).toEqual({})
    expect(ref && existsSync(join(testState.root, 'terminal-scrollback', `${ref}.bin`))).toBe(false)
  })

  it('retries a failed timer prune with a bounded backoff and a non-sensitive diagnostic', async () => {
    vi.useFakeTimers()
    let currentTime = 0
    const repo = repository()
    const replace = repo.value.replaceTerminalArchivesAndFlush
    let failNextPrune = true
    repo.value.replaceTerminalArchivesAndFlush = (archives) => {
      if (failNextPrune && Object.keys(archives).length === 0) {
        failNextPrune = false
        throw new Error('disk unavailable')
      }
      replace(archives)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = new TerminalArchiveStore(repo.value, source(), () => currentTime)
    const archive = await store.archiveTerminalTab(request())

    currentTime = RETENTION_MS
    await vi.advanceTimersByTimeAsync(RETENTION_MS)

    expect(repo.archives[archive.id]).toBeDefined()
    expect(warn).toHaveBeenCalledWith(
      '[terminal-archive] Failed to prune expired archives; retrying'
    )
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(repo.archives[archive.id]).toBeDefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(repo.archives).toEqual({})
    warn.mockRestore()
  })

  it('cancels the expiry timer when disposed', async () => {
    vi.useFakeTimers()
    let currentTime = 0
    const repo = repository()
    const store = new TerminalArchiveStore(repo.value, source(), () => currentTime)
    const archive = await store.archiveTerminalTab(request())

    store.dispose()
    currentTime = RETENTION_MS
    await vi.advanceTimersByTimeAsync(RETENTION_MS * 2)

    expect(repo.archives[archive.id]).toBeDefined()
  })
})

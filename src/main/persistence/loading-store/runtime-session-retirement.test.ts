import { isRuntimeSessionRetired } from './runtime-session-retirement'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import { createSqliteTestStore, readPersistedStateJson } from '../../persistence-test-harness'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { Store } from './store'
import {
  getProfileTerminalScrollbackSnapshotRoot,
  readTerminalScrollbackSnapshotSync,
  writeTerminalScrollbackSnapshotSync
} from '../../terminal-scrollback-snapshots'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getName: () => 'orca-test', getVersion: () => '0.0.0', on() {} },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] }
}))

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})
const HOST = 'runtime:gone'
const WORKSPACE = 'folder:retired-folder'
const LEAF = '33333333-3333-4333-8333-333333333333'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-session-archive-'))
  const dataFile = join(dir, 'profile', 'orca-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  const archiveRoot = join(dir, 'profile', 'retired-runtime-sessions')
  cleanups.push(async () => {
    await store.freezeWritesAsync()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, dataFile, store, archiveRoot }
}

function draft(content = 'unsaved\n\u0000\r\n🚢'): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: {
      [WORKSPACE]: [
        {
          filePath: '/gone/file.txt',
          relativePath: 'file.txt',
          worktreeId: WORKSPACE,
          language: 'plaintext',
          runtimeEnvironmentId: 'gone',
          dirtyDraftContent: content,
          lastKnownDiskSignature: 'recorded-baseline'
        }
      ]
    }
  }
}

it('archives exact unsaved text and referenced scrollback before removing active state', async () => {
  const { store, dataFile, archiveRoot } = fixture()
  const ref = writeTerminalScrollbackSnapshotSync({
    tabId: 'tab',
    leafId: LEAF,
    buffer: 'captured terminal\r\n',
    storage: { snapshotRoot: getProfileTerminalScrollbackSnapshotRoot(dataFile) }
  })
  if (!ref) {
    throw new Error('Missing fixture snapshot')
  }
  const session = {
    ...draft(),
    tabsByWorktree: {
      [WORKSPACE]: [
        {
          id: 'tab',
          worktreeId: WORKSPACE,
          ptyId: null,
          title: 'Tab',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf' as const, leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        scrollbackRefsByLeafId: { [LEAF]: ref }
      }
    }
  }
  store.setWorkspaceSession(session, HOST)
  const prior = structuredClone(store.getWorkspaceSession(HOST))
  await expect(store.removeRuntimeWorkspaceSessionPartition(HOST)).resolves.toBe(true)
  expect(store.getWorkspaceSessionHostIds()).not.toContain(HOST)
  const files = readdirSync(archiveRoot)
  expect(files).toHaveLength(1)
  const archive = JSON.parse(readFileSync(join(archiveRoot, files[0]!), 'utf8'))
  expect(archive).toMatchObject({
    version: 1,
    hostId: HOST,
    session: prior,
    snapshots: { [ref]: 'captured terminal\r\n' },
    missingSnapshots: []
  })
  const state = JSON.parse(readPersistedStateJson(dataFile))
  expect(state.retiredRuntimeWorkspaceSessions[HOST].archiveFile).toBe(files[0])
  expect(store.readTerminalScrollbackSnapshot(ref)).toBeNull()
})

it.each(['full', 'patch', 'before-unload', 'pty'] as const)(
  'keeps a durable fence against a late %s writer after restart',
  async (writer) => {
    const { store, dataFile } = fixture()
    store.setWorkspaceSession(draft(), HOST)
    await store.removeRuntimeWorkspaceSessionPartition(HOST)
    await store.freezeWritesAsync()
    const restarted = createSqliteTestStore(Store, { dataFile })
    cleanups.unshift(() => restarted.freezeWritesAsync())
    expect(restarted.isRuntimeWorkspaceSessionRetired(HOST)).toBe(true)
    if (writer === 'full') {
      restarted.setWorkspaceSession(draft('late'), HOST)
    }
    if (writer === 'patch') {
      restarted.patchWorkspaceSession({ activeTabId: 'late' }, HOST)
    }
    if (writer === 'before-unload') {
      restarted.stageWorkspaceSessionBeforeUnload(draft('late'), HOST)
    }
    if (writer === 'pty') {
      await expect(
        restarted.persistPtyBinding(
          {
            worktreeId: WORKSPACE,
            tabId: 'late',
            leafId: LEAF,
            ptyId: 'late',
            incarnationId: 'late'
          },
          HOST
        )
      ).resolves.toBe(false)
    }
    await restarted.flushPendingOrThrowAsync()
    expect(restarted.getWorkspaceSessionHostIds()).not.toContain(HOST)
    expect(
      JSON.parse(readPersistedStateJson(dataFile)).workspaceSessionsByHostId
    ).not.toHaveProperty(HOST)
  }
)

it('keeps the active draft and ordinary saves working when archive creation fails', async () => {
  const { store, archiveRoot } = fixture()
  store.setWorkspaceSession(draft(), HOST)
  mkdirSync(join(archiveRoot, '..'), { recursive: true })
  writeFileSync(archiveRoot, 'blocking file')
  await expect(store.removeRuntimeWorkspaceSessionPartition(HOST)).rejects.toThrow()
  expect(store.getWorkspaceSession(HOST).openFilesByWorktree).toEqual(draft().openFilesByWorktree)
  expect(store.isRuntimeWorkspaceSessionRetired(HOST)).toBe(false)
  store.patchWorkspaceSession({ activeTabId: 'still writable' }, HOST)
  await store.flushPendingOrThrowAsync()
  expect(store.getWorkspaceSession(HOST).activeTabId).toBe('still writable')
})

it('restores the partition on a failed SQLite commit and leaves its recovery archive intact', async () => {
  const { store, dataFile, archiveRoot } = fixture()
  store.setWorkspaceSession(draft(), HOST)
  store.flushOrThrow()
  vi.spyOn(
    ProfileStateSqliteAuthority.prototype,
    'writeCompleteSerializedDomains'
  ).mockImplementationOnce(() => {
    throw new Error('disk full')
  })
  vi.spyOn(ProfileStateSqliteAuthority.prototype, 'writeSerializedDomains').mockImplementationOnce(
    () => {
      throw new Error('disk full')
    }
  )
  await expect(store.removeRuntimeWorkspaceSessionPartition(HOST)).rejects.toThrow('disk full')
  expect(store.isRuntimeWorkspaceSessionRetired(HOST)).toBe(false)
  expect(store.getWorkspaceSession(HOST).openFilesByWorktree).toEqual(draft().openFilesByWorktree)
  expect(JSON.parse(readPersistedStateJson(dataFile)).workspaceSessionsByHostId).toHaveProperty(
    HOST
  )
  expect(readdirSync(archiveRoot)).toHaveLength(1)
})

it('rechecks custody inside the queue before taking any archive or state away', async () => {
  const { store, archiveRoot } = fixture()
  store.setWorkspaceSession(draft(), HOST)
  const custody = vi.fn(() => true)
  await expect(store.removeRuntimeWorkspaceSessionPartition(HOST, custody)).resolves.toBe(false)
  expect(custody).toHaveBeenCalledOnce()
  expect(store.getWorkspaceSessionHostIds()).toContain(HOST)
  expect(() => readdirSync(archiveRoot)).toThrow()
})

it('preserves an oversized draft instead of producing a partial archive or freezing other saves', async () => {
  const { store, archiveRoot } = fixture()
  const oversized = 'x'.repeat(64 * 1024 * 1024)
  store.setWorkspaceSession(draft(oversized), HOST)
  await expect(store.removeRuntimeWorkspaceSessionPartition(HOST)).rejects.toThrow()
  expect(
    store.getWorkspaceSession(HOST).openFilesByWorktree?.[WORKSPACE]?.[0]?.dirtyDraftContent
  ).toBe(oversized)
  expect(store.isRuntimeWorkspaceSessionRetired(HOST)).toBe(false)
  expect(() => readdirSync(archiveRoot)).toThrow()
  store.setWorkspaceSession(draft('small after refusal'), HOST)
  await store.flushPendingOrThrowAsync()
})

it('never lets malformed archive metadata fence local or SSH saves', () => {
  const valid = { archiveFile: '33333333-3333-4333-8333-333333333333.json', retiredAt: 1 }
  const runtime = {
    state: {
      ...getDefaultPersistedState(tmpdir()),
      retiredRuntimeWorkspaceSessions: {
        local: valid,
        'ssh:direct': valid,
        'runtime:gone': { archiveFile: '../outside.json', retiredAt: 1 }
      }
    }
  }
  expect(isRuntimeSessionRetired(runtime, 'local')).toBe(false)
  expect(isRuntimeSessionRetired(runtime, 'ssh:direct')).toBe(false)
  expect(isRuntimeSessionRetired(runtime, 'runtime:gone')).toBe(false)
})

it.each(['full', 'patch', 'before-unload'] as const)(
  'archives a newer unsaved draft from a late %s without resurrecting the partition',
  async (writer) => {
    const { store, archiveRoot } = fixture()
    store.setWorkspaceSession(draft('first draft'), HOST)
    await store.removeRuntimeWorkspaceSessionPartition(HOST)
    const newer = draft('newer unsaved draft')
    for (let repeat = 0; repeat < 3; repeat++) {
      if (writer === 'full') {
        store.setWorkspaceSession(newer, HOST)
      }
      if (writer === 'patch') {
        store.patchWorkspaceSession({ openFilesByWorktree: newer.openFilesByWorktree }, HOST)
      }
      if (writer === 'before-unload') {
        store.stageWorkspaceSessionBeforeUnload(newer, HOST)
      }
    }
    await store.flushPendingOrThrowAsync()
    expect(store.getWorkspaceSessionHostIds()).not.toContain(HOST)
    const archives = readdirSync(archiveRoot).map((file) =>
      JSON.parse(readFileSync(join(archiveRoot, file), 'utf8'))
    )
    expect(archives).toHaveLength(2)
    expect(archives).toContainEqual(
      expect.objectContaining({
        kind: 'late-editor-draft',
        hostId: HOST,
        session: expect.objectContaining({ openFilesByWorktree: newer.openFilesByWorktree })
      })
    )
  }
)

it('keeps identical late drafts from different retired hosts in separate archives', async () => {
  const { store, archiveRoot } = fixture()
  const otherHost = 'runtime:other-gone'
  for (const host of [HOST, otherHost] as const) {
    store.setWorkspaceSession(draft(), host)
    await store.removeRuntimeWorkspaceSessionPartition(host)
    store.setWorkspaceSession(draft('same newer text'), host)
  }
  const late = readdirSync(archiveRoot)
    .map((file) => JSON.parse(readFileSync(join(archiveRoot, file), 'utf8')))
    .filter((archive) => archive.kind === 'late-editor-draft')
  expect(late.map((archive) => archive.hostId).sort()).toEqual([HOST, otherHost].sort())
})

function draftWithScrollback(tabId: string, ref: string): WorkspaceSessionState {
  return {
    ...draft(),
    tabsByWorktree: {
      [WORKSPACE]: [
        {
          id: tabId,
          worktreeId: WORKSPACE,
          ptyId: null,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        scrollbackRefsByLeafId: { [LEAF]: ref }
      }
    }
  }
}

it('archives stored scrollback beyond the smaller replay window without losing its prefix', async () => {
  const { store, dataFile, archiveRoot } = fixture()
  const buffer = `original prefix\n${'x'.repeat(1024 * 1024)}original tail`
  const ref = writeTerminalScrollbackSnapshotSync({
    tabId: 'large',
    leafId: LEAF,
    buffer,
    storage: { snapshotRoot: getProfileTerminalScrollbackSnapshotRoot(dataFile) }
  })
  if (!ref) {
    throw new Error('Missing snapshot')
  }
  store.setWorkspaceSession(draftWithScrollback('large', ref), HOST)
  await store.removeRuntimeWorkspaceSessionPartition(HOST)
  const file = readdirSync(archiveRoot)[0]!
  const archive = JSON.parse(readFileSync(join(archiveRoot, file), 'utf8'))
  expect(archive.snapshots[ref]?.length).toBe(buffer.length)
  expect(archive.snapshots[ref]?.startsWith('original prefix\n')).toBe(true)
  expect(archive.snapshots[ref] === buffer).toBe(true)
})

it('keeps an oversized legacy snapshot when it cannot be fully archived', async () => {
  const { store, dataFile, archiveRoot } = fixture()
  const snapshotRoot = getProfileTerminalScrollbackSnapshotRoot(dataFile)
  const ref = writeTerminalScrollbackSnapshotSync({
    tabId: 'oversized',
    leafId: LEAF,
    buffer: 'original',
    storage: { snapshotRoot }
  })
  if (!ref) {
    throw new Error('Missing snapshot')
  }
  const rawPath = join(snapshotRoot, `${ref}.bin`)
  const original = 'x'.repeat(5 * 1024 * 1024 + 1)
  writeFileSync(rawPath, original)
  store.setWorkspaceSession(draftWithScrollback('oversized', ref), HOST)
  await store.removeRuntimeWorkspaceSessionPartition(HOST)
  const archive = JSON.parse(readFileSync(join(archiveRoot, readdirSync(archiveRoot)[0]!), 'utf8'))
  expect(archive.missingSnapshots).toContain(ref)
  expect(readFileSync(rawPath, 'utf8')).toBe(original)
})

it('does not substitute a stale fallback for an oversized primary archive', () => {
  const { dir, dataFile } = fixture()
  const snapshotRoot = getProfileTerminalScrollbackSnapshotRoot(dataFile)
  const fallbackSnapshotRoot = join(dir, 'fallback')
  const ref = writeTerminalScrollbackSnapshotSync({
    tabId: 'fallback',
    leafId: LEAF,
    buffer: 'primary',
    storage: { snapshotRoot }
  })
  if (!ref) {
    throw new Error('Missing snapshot')
  }
  mkdirSync(fallbackSnapshotRoot, { recursive: true })
  writeFileSync(join(fallbackSnapshotRoot, `${ref}.bin`), 'stale fallback')
  writeFileSync(join(snapshotRoot, `${ref}.bin`), 'x'.repeat(5 * 1024 * 1024 + 1))
  expect(
    readTerminalScrollbackSnapshotSync(
      ref,
      { snapshotRoot, fallbackSnapshotRoot },
      { purpose: 'archive' }
    ) === null
  ).toBe(true)
})

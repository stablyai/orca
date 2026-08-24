import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileRangeReadResult, FileStat, IFilesystemProvider } from '../providers/types'

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn<(connectionId: string) => IFilesystemProvider | undefined>(),
  generation: 1,
  changeListeners: new Set<(connectionId: string, generation: number) => void>(),
  ownerListeners: new Set<() => void>(),
  statusRows: [] as Record<string, unknown>[],
  retainedOwners: [] as Record<string, unknown>[],
  unresolvedOwner: false,
  awaitHydration: () => Promise.resolve()
}))

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    getStatusSnapshot: () => mocks.statusRows,
    getStatusSnapshotForPane: (paneKey: string) =>
      mocks.statusRows.filter((row) => row.paneKey === paneKey),
    getTranscriptOwnerEvidence: (paneKey?: string) =>
      paneKey
        ? mocks.retainedOwners.filter((owner) => owner.paneKey === paneKey)
        : mocks.retainedOwners,
    hasUnresolvedRemoteTranscriptOwner: () => mocks.unresolvedOwner,
    awaitTranscriptOwnerHydration: () => mocks.awaitHydration(),
    subscribeTranscriptOwnerChanges: (listener: () => void) => {
      mocks.ownerListeners.add(listener)
      return () => mocks.ownerListeners.delete(listener)
    }
  }
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: mocks.getProvider,
  getSshFilesystemProviderSnapshot: (connectionId: string) => {
    const provider = mocks.getProvider(connectionId)
    return provider ? { provider, generation: mocks.generation } : null
  },
  onSshFilesystemProviderRegistered: () => () => undefined,
  onSshFilesystemProviderChanged: (
    listener: (connectionId: string, generation: number) => void
  ) => {
    mocks.changeListeners.add(listener)
    return () => mocks.changeListeners.delete(listener)
  },
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE: 'Remote connection dropped.'
}))

import {
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTail
} from './transcript-tail-reader'
import { getActiveNativeChatWatcherCount, subscribeNativeChatTranscript } from './transcript-watch'
import { readIncrementalTranscriptMessages } from './transcript-incremental-reader'
import { TranscriptRangeReadInvalidatedError, type TranscriptRangeFs } from './transcript-range-fs'

const SESSION_ID = 'session-ssh-owner'
const PANE_KEY = 'tab-owner:11111111-1111-4111-8111-111111111111'

function claudeLine(id: string, text: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid: id,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })}\n`
}

function memoryProvider(files: Map<string, Buffer>) {
  const readFile = vi.fn(async () => {
    throw new Error('whole-file reads are forbidden for transcript tailing')
  })
  const readFileRange = vi.fn(
    async (filePath: string, position: number, length: number): Promise<FileRangeReadResult> => {
      const bytes = files.get(filePath)?.subarray(position, position + length)
      if (!bytes) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), {
          code: 'ENOENT'
        })
      }
      return { bytes, bytesRead: bytes.length }
    }
  )
  const stat = vi.fn(async (filePath: string): Promise<FileStat> => {
    const bytes = files.get(filePath)
    if (!bytes) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${filePath}'`), {
        code: 'ENOENT'
      })
    }
    return { size: bytes.length, type: 'file', mtime: 1, mtimeMs: 1, dev: 7, ino: 11 }
  })
  const provider = {
    stat,
    readFile,
    readFileRange,
    async supportsFileRangeRead() {
      return true
    }
  } as unknown as IFilesystemProvider
  return { provider, readFile, readFileRange, stat }
}

function routedArgs(transcriptPath: string): {
  agent: 'claude'
  sessionId: string
  transcriptPath: string
  paneKey: string
} {
  setOwner('ssh-owner', transcriptPath)
  return {
    agent: 'claude' as const,
    sessionId: SESSION_ID,
    transcriptPath,
    paneKey: PANE_KEY
  }
}

function setOwner(connectionId: string | null, transcriptPath?: string): void {
  setStatusRows([
    {
      paneKey: PANE_KEY,
      agentType: 'claude',
      connectionId,
      providerSession: {
        key: 'session_id',
        id: SESSION_ID,
        ...(transcriptPath ? { transcriptPath } : {})
      }
    }
  ])
}

function setStatusRows(rows: Record<string, unknown>[]): void {
  mocks.statusRows = rows
  for (const listener of mocks.ownerListeners) {
    listener()
  }
}

function changeProvider(provider: IFilesystemProvider | undefined): void {
  mocks.getProvider.mockReturnValue(provider)
  mocks.generation++
  for (const listener of mocks.changeListeners) {
    listener('ssh-owner', mocks.generation)
  }
}

let tempRoots: string[] = []

beforeEach(() => {
  mocks.getProvider.mockReset()
  mocks.generation = 1
  mocks.changeListeners.clear()
  mocks.ownerListeners.clear()
  mocks.statusRows = []
  mocks.retainedOwners = []
  mocks.unresolvedOwner = false
  mocks.awaitHydration = () => Promise.resolve()
  tempRoots = []
})

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('native chat SSH transcript host routing (#13663)', () => {
  it('reads the owning provider while rejecting a desktop same-path lookalike', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-host-route-'))
    tempRoots.push(root)
    const transcriptPath = join(root, 'session.jsonl')
    await writeFile(transcriptPath, claudeLine('desktop-poison', 'wrong host'))
    const files = new Map([[transcriptPath, Buffer.from(claudeLine('remote-real', 'right host'))]])
    const { provider, readFile, readFileRange, stat } = memoryProvider(files)
    mocks.getProvider.mockReturnValue(provider)
    const controller = new AbortController()

    const result = await readNativeChatTranscriptTail(
      {
        ...routedArgs(transcriptPath),
        limit: 40
      } as Parameters<typeof readNativeChatTranscriptTail>[0],
      controller.signal
    )

    expect(result).toMatchObject({ messages: [{ id: 'remote-real' }], hasMore: false })
    expect(result).not.toMatchObject({ messages: [{ id: 'desktop-poison' }] })
    expect(mocks.getProvider).toHaveBeenCalledWith('ssh-owner')
    expect(readFile).not.toHaveBeenCalled()
    expect(readFileRange).toHaveBeenCalled()
    expect(stat).toHaveBeenCalledWith(transcriptPath, { signal: controller.signal })
  })

  it('ignores a caller transcript path that contradicts the hook-owned path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-path-authority-'))
    tempRoots.push(root)
    const callerPath = join(root, 'caller.jsonl')
    const ownedPath = '/remote/owned.jsonl'
    await writeFile(callerPath, claudeLine('caller-poison', 'wrong path'))
    const remote = memoryProvider(
      new Map([[ownedPath, Buffer.from(claudeLine('hook-owned', 'right path'))]])
    )
    mocks.getProvider.mockReturnValue(remote.provider)
    setOwner('ssh-owner', ownedPath)

    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: SESSION_ID,
      transcriptPath: callerPath,
      paneKey: PANE_KEY,
      limit: 40
    })

    expect(result).toMatchObject({ messages: [{ id: 'hook-owned' }] })
    expect(remote.stat).toHaveBeenCalledWith(ownedPath, expect.anything())
    expect(remote.stat).not.toHaveBeenCalledWith(callerPath, expect.anything())
  })

  it('retries consecutive ranged snapshots when the remote file is replaced mid-read', async () => {
    const transcriptPath = '/tmp/replaced-mid-read.jsonl'
    const oldBytes = Buffer.from(
      `${claudeLine('old-large', 'a'.repeat(80_000))}${claudeLine('old-tail', 'old')}`
    )
    const middleBytes = Buffer.from(
      `${claudeLine('middle-large', 'b'.repeat(80_000))}${claudeLine('middle-tail', 'middle')}`
    )
    const newBytes = Buffer.from(
      `${claudeLine('new-large', 'c'.repeat(80_000))}${claudeLine('new-tail', 'new')}`
    )
    let current = oldBytes
    let inode = 11
    let rangeReadCount = 0
    const readFileRange = vi.fn(
      async (_filePath: string, position: number, length: number): Promise<FileRangeReadResult> => {
        const bytes = current.subarray(position, position + length)
        rangeReadCount++
        if (rangeReadCount === 3) {
          current = middleBytes
          inode = 12
        } else if (rangeReadCount === 6) {
          current = newBytes
          inode = 13
        }
        return { bytes, bytesRead: bytes.length }
      }
    )
    const provider = {
      async stat(): Promise<FileStat> {
        return {
          size: current.length,
          type: 'file',
          mtime: inode,
          mtimeMs: inode,
          dev: 7,
          ino: inode
        }
      },
      readFile: vi.fn(async () => {
        throw new Error('whole-file reads are forbidden for transcript tailing')
      }),
      readFileRange,
      async supportsFileRangeRead() {
        return true
      }
    } as unknown as IFilesystemProvider
    mocks.getProvider.mockReturnValue(provider)

    const result = await readNativeChatTranscriptTail({
      ...routedArgs(transcriptPath),
      limit: 40
    })

    expect(result).toMatchObject({ messages: [{ id: 'new-large' }, { id: 'new-tail' }] })
    expect(result).not.toMatchObject({ messages: [{ id: 'old-large' }, { id: 'old-tail' }] })
    expect(readFileRange.mock.calls.length).toBeGreaterThan(7)
  })

  it('withholds remote append batches and restores the cursor after invalidation', async () => {
    const bytes = Buffer.from(
      Array.from({ length: 50 }, (_, index) => claudeLine(`stale-${index}`, `stale ${index}`)).join(
        ''
      )
    )
    const onBatch = vi.fn()
    const state = {
      offset: 0,
      pendingChunks: [] as Buffer[],
      pendingStart: 0,
      pendingBytes: 0,
      droppingOversizedRecord: false
    }
    const rangeFs: TranscriptRangeFs = {
      async stat() {
        return {
          size: bytes.length,
          identity: '1:7:11',
          mtimeMs: 1,
          ctimeMs: 1
        }
      },
      async read(_filePath, position, length) {
        return bytes.subarray(position, position + length)
      },
      async assertStable() {
        throw new TranscriptRangeReadInvalidatedError()
      }
    }

    await expect(
      readIncrementalTranscriptMessages(
        '/tmp/invalidated-append.jsonl',
        state,
        nativeChatLineDecoderForAgent('claude')!,
        onBatch,
        undefined,
        undefined,
        undefined,
        rangeFs
      )
    ).rejects.toBeInstanceOf(TranscriptRangeReadInvalidatedError)
    expect(onBatch).not.toHaveBeenCalled()
    expect(state).toMatchObject({ offset: 0, pendingStart: 0, pendingBytes: 0 })
  })

  it('emits the remote snapshot and later tail without whole-file polling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-host-tail-'))
    tempRoots.push(root)
    const transcriptPath = join(root, 'session.jsonl')
    await writeFile(transcriptPath, claudeLine('desktop-poison', 'wrong host'))
    const files = new Map([[transcriptPath, Buffer.from(claudeLine('remote-first', 'first'))]])
    const { provider, readFile, readFileRange } = memoryProvider(files)
    mocks.getProvider.mockReturnValue(provider)
    const snapshots: string[][] = []
    const appended: string[] = []

    const subscription = await subscribeNativeChatTranscript({
      ...routedArgs(transcriptPath),
      initialLimit: 40,
      onInitialSnapshot: (messages) => snapshots.push(messages.map((message) => message.id)),
      onAppend: (messages) => appended.push(...messages.map((message) => message.id)),
      debounceMs: 0,
      reconciliationIntervalMs: 20
    } as Parameters<typeof subscribeNativeChatTranscript>[0])

    try {
      await vi.waitFor(() => expect(snapshots).toContainEqual(['remote-first']))
      files.set(
        transcriptPath,
        Buffer.from(`${claudeLine('remote-first', 'first')}${claudeLine('remote-next', 'next')}`)
      )
      await vi.waitFor(() => expect(appended).toContain('remote-next'))

      expect(snapshots.flat()).not.toContain('desktop-poison')
      expect(readFile).not.toHaveBeenCalled()
      expect(readFileRange).toHaveBeenCalled()
    } finally {
      subscription.unsubscribe()
    }
  })

  it('never falls back locally when ownership is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-host-unknown-'))
    tempRoots.push(root)
    const transcriptPath = join(root, 'session.jsonl')
    await writeFile(transcriptPath, claudeLine('desktop-poison', 'wrong host'))

    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: SESSION_ID,
      transcriptPath,
      paneKey: PANE_KEY,
      limit: 40
    })

    expect(result).toEqual({ error: 'Transcript unverifiable on the remote host' })
    expect(mocks.getProvider).not.toHaveBeenCalled()
  })

  it('never installs a local watcher when subscription ownership is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-host-unknown-watch-'))
    tempRoots.push(root)
    const transcriptPath = join(root, 'session.jsonl')
    await writeFile(transcriptPath, claudeLine('desktop-poison', 'wrong host'))
    const before = getActiveNativeChatWatcherCount()
    const snapshots: { ids: string[]; error?: string }[] = []

    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: SESSION_ID,
      transcriptPath,
      paneKey: PANE_KEY,
      onInitialSnapshot: (messages, _hasMore, _beforeOffset, error) =>
        snapshots.push({ ids: messages.map((message) => message.id), error }),
      onAppend: () => {}
    })

    expect(snapshots).toEqual([{ ids: [], error: 'Transcript unverifiable on the remote host' }])
    expect(getActiveNativeChatWatcherCount()).toBe(before)
    expect(mocks.getProvider).not.toHaveBeenCalled()
    subscription.unsubscribe()
  })

  it('keeps stamped local sessions on the existing local reader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-host-local-'))
    tempRoots.push(root)
    const transcriptPath = join(root, 'session.jsonl')
    await writeFile(transcriptPath, claudeLine('local-real', 'local host'))
    setOwner(null, transcriptPath)

    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: SESSION_ID,
      transcriptPath,
      paneKey: PANE_KEY,
      limit: 40
    })

    expect(result).toMatchObject({ messages: [{ id: 'local-real' }] })
    expect(mocks.getProvider).not.toHaveBeenCalled()
  })

  it('treats WSL hook provenance as local transcript ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-host-wsl-'))
    tempRoots.push(root)
    const transcriptPath = join(root, 'session.jsonl')
    await writeFile(transcriptPath, claudeLine('wsl-local', 'local WSL bridge'))
    setOwner('wsl:Ubuntu', transcriptPath)

    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: SESSION_ID,
      transcriptPath,
      paneKey: PANE_KEY,
      limit: 40
    })

    expect(result).toMatchObject({ messages: [{ id: 'wsl-local' }] })
    expect(mocks.getProvider).not.toHaveBeenCalled()
  })

  it('keeps locator-free legacy requests host-local for older clients', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-host-legacy-local-'))
    tempRoots.push(root)
    const transcriptPath = join(root, 'session.jsonl')
    await writeFile(transcriptPath, claudeLine('legacy-local', 'older client'))

    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: SESSION_ID,
      transcriptPath,
      limit: 40
    })

    expect(result).toMatchObject({ messages: [{ id: 'legacy-local' }] })
    expect(mocks.getProvider).not.toHaveBeenCalled()
  })

  it('selects the requested pane when two hosts expose the same session id and path', async () => {
    const transcriptPath = '/tmp/same-session.jsonl'
    const wrong = memoryProvider(
      new Map([[transcriptPath, Buffer.from(claudeLine('wrong-remote', 'wrong host'))]])
    )
    const right = memoryProvider(
      new Map([[transcriptPath, Buffer.from(claudeLine('right-remote', 'right host'))]])
    )
    mocks.getProvider.mockImplementation((connectionId) =>
      connectionId === 'ssh-owner' ? right.provider : wrong.provider
    )
    setStatusRows([
      {
        paneKey: 'other-pane:11111111-1111-4111-8111-111111111111',
        agentType: 'claude',
        connectionId: 'wrong-owner',
        providerSession: { key: 'session_id', id: SESSION_ID, transcriptPath }
      },
      {
        paneKey: PANE_KEY,
        agentType: 'claude',
        connectionId: 'ssh-owner',
        providerSession: { key: 'session_id', id: SESSION_ID, transcriptPath }
      }
    ])

    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: SESSION_ID,
      transcriptPath,
      paneKey: PANE_KEY,
      limit: 40
    })

    expect(result).toMatchObject({ messages: [{ id: 'right-remote' }] })
    expect(right.readFileRange).toHaveBeenCalled()
    expect(wrong.readFileRange).not.toHaveBeenCalled()
  })

  it('does not use a caller path to disambiguate locator-free ownership', async () => {
    const requestedPath = '/tmp/requested.jsonl'
    setStatusRows([
      {
        paneKey: PANE_KEY,
        agentType: 'claude',
        connectionId: 'ssh-owner',
        providerSession: { key: 'session_id', id: SESSION_ID, transcriptPath: requestedPath }
      },
      {
        paneKey: 'other-pane:11111111-1111-4111-8111-111111111111',
        agentType: 'claude',
        connectionId: 'wrong-owner',
        providerSession: {
          key: 'session_id',
          id: SESSION_ID,
          transcriptPath: '/tmp/other.jsonl'
        }
      }
    ])

    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: SESSION_ID,
      transcriptPath: requestedPath,
      limit: 40
    })

    expect(result).toEqual({ error: 'Transcript unverifiable on the remote host' })
    expect(mocks.getProvider).not.toHaveBeenCalled()
  })

  it('does not run desktop id discovery when an SSH locator has no transcript path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-host-no-path-'))
    tempRoots.push(root)
    const projectDir = join(root, 'project')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), claudeLine('desktop-id-hit', 'wrong'))
    setOwner('ssh-owner')

    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: SESSION_ID,
      claudeProjectsDir: root,
      paneKey: PANE_KEY,
      limit: 40
    })

    expect(result).toMatchObject({ notFound: true })
    expect(result).not.toHaveProperty('messages')

    const snapshots: { ids: string[]; error?: string }[] = []
    const before = getActiveNativeChatWatcherCount()
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: SESSION_ID,
      claudeProjectsDir: root,
      paneKey: PANE_KEY,
      onInitialSnapshot: (messages, _hasMore, _beforeOffset, error) =>
        snapshots.push({ ids: messages.map((message) => message.id), error }),
      onAppend: () => {}
    })

    expect(snapshots).toEqual([{ ids: [], error: 'Transcript unavailable' }])
    expect(getActiveNativeChatWatcherCount()).toBe(before)
    subscription.unsubscribe()
  })

  it('rearms on provider replacement and emits the new remote snapshot', async () => {
    const transcriptPath = '/tmp/reconnected-session.jsonl'
    const first = memoryProvider(
      new Map([[transcriptPath, Buffer.from(claudeLine('before-reconnect', 'first'))]])
    )
    const second = memoryProvider(
      new Map([[transcriptPath, Buffer.from(claudeLine('after-reconnect', 'second'))]])
    )
    mocks.getProvider.mockReturnValue(first.provider)
    const snapshots: string[][] = []
    const subscription = await subscribeNativeChatTranscript({
      ...routedArgs(transcriptPath),
      initialLimit: 40,
      onInitialSnapshot: (messages) => snapshots.push(messages.map((message) => message.id)),
      onAppend: () => {},
      debounceMs: 0,
      reconciliationIntervalMs: 20
    })

    try {
      await vi.waitFor(() => expect(snapshots).toContainEqual(['before-reconnect']))
      changeProvider(second.provider)
      await vi.waitFor(() => expect(snapshots).toContainEqual(['after-reconnect']))
      expect(first.readFile).not.toHaveBeenCalled()
      expect(second.readFile).not.toHaveBeenCalled()
    } finally {
      subscription.unsubscribe()
    }
  })

  it('fails closed when the owner row disappears and rebinds when it returns', async () => {
    const transcriptPath = '/tmp/rebound-owner-session.jsonl'
    const remote = memoryProvider(
      new Map([[transcriptPath, Buffer.from(claudeLine('remote-owner', 'remote'))]])
    )
    mocks.getProvider.mockReturnValue(remote.provider)
    const snapshots: { ids: string[]; error?: string }[] = []
    const subscription = await subscribeNativeChatTranscript({
      ...routedArgs(transcriptPath),
      initialLimit: 40,
      onInitialSnapshot: (messages, _hasMore, _beforeOffset, error) =>
        snapshots.push({ ids: messages.map((message) => message.id), error }),
      onAppend: () => {},
      debounceMs: 0,
      reconciliationIntervalMs: 20
    })

    try {
      await vi.waitFor(() =>
        expect(snapshots).toContainEqual({ ids: ['remote-owner'], error: undefined })
      )
      setStatusRows([])
      await vi.waitFor(() =>
        expect(snapshots).toContainEqual({
          ids: [],
          error: 'Transcript unverifiable on the remote host'
        })
      )
      setOwner('ssh-owner', transcriptPath)
      await vi.waitFor(() =>
        expect(snapshots.filter((snapshot) => snapshot.ids.includes('remote-owner'))).toHaveLength(
          2
        )
      )
    } finally {
      subscription.unsubscribe()
    }
  })

  it('recovers from provider loss with one fresh watcher and no stale snapshot', async () => {
    const transcriptPath = '/work/folder-workspace/session.jsonl'
    const first = memoryProvider(
      new Map([[transcriptPath, Buffer.from(claudeLine('before-loss', 'first'))]])
    )
    const restored = memoryProvider(
      new Map([[transcriptPath, Buffer.from(claudeLine('after-restore', 'second'))]])
    )
    mocks.getProvider.mockReturnValue(first.provider)
    const before = getActiveNativeChatWatcherCount()
    const snapshots: { ids: string[]; error?: string }[] = []
    const subscription = await subscribeNativeChatTranscript({
      ...routedArgs(transcriptPath),
      initialLimit: 40,
      onInitialSnapshot: (messages, _hasMore, _beforeOffset, error) =>
        snapshots.push({ ids: messages.map((message) => message.id), error }),
      onAppend: () => {},
      debounceMs: 0,
      reconciliationIntervalMs: 20
    })

    try {
      await vi.waitFor(() =>
        expect(snapshots).toContainEqual({ ids: ['before-loss'], error: undefined })
      )
      expect(getActiveNativeChatWatcherCount()).toBe(before + 1)

      changeProvider(undefined)
      await vi.waitFor(() =>
        expect(snapshots).toContainEqual({
          ids: [],
          error: 'Transcript unverifiable on the remote host'
        })
      )
      expect(getActiveNativeChatWatcherCount()).toBe(before)

      changeProvider(restored.provider)
      await vi.waitFor(() =>
        expect(snapshots).toContainEqual({ ids: ['after-restore'], error: undefined })
      )
      expect(getActiveNativeChatWatcherCount()).toBe(before + 1)
      expect(snapshots.some((snapshot) => snapshot.ids.includes('before-loss'))).toBe(true)
      expect(snapshots.at(-1)?.ids).toEqual(['after-restore'])

      const firstOutageFrames = snapshots.filter(
        (snapshot) => snapshot.error === 'Transcript unverifiable on the remote host'
      ).length
      changeProvider(undefined)
      await vi.waitFor(() =>
        expect(
          snapshots.filter(
            (snapshot) => snapshot.error === 'Transcript unverifiable on the remote host'
          )
        ).toHaveLength(firstOutageFrames + 1)
      )
      expect(getActiveNativeChatWatcherCount()).toBe(before)
    } finally {
      subscription.unsubscribe()
    }
    expect(getActiveNativeChatWatcherCount()).toBe(before)
  })

  it('keeps retrying when an unverifiable advisory subscriber throws', async () => {
    const transcriptPath = '/tmp/throwing-subscriber-session.jsonl'
    const restored = memoryProvider(
      new Map([[transcriptPath, Buffer.from(claudeLine('recovered-after-throw', 'second'))]])
    )
    mocks.getProvider.mockReturnValue(undefined)
    const snapshots: string[][] = []
    const subscription = await subscribeNativeChatTranscript({
      ...routedArgs(transcriptPath),
      initialLimit: 40,
      onInitialSnapshot: (messages, _hasMore, _beforeOffset, error) => {
        if (error) {
          throw new Error('subscriber is closing')
        }
        snapshots.push(messages.map((message) => message.id))
      },
      onAppend: () => {},
      debounceMs: 0,
      reconciliationIntervalMs: 20
    })

    try {
      changeProvider(restored.provider)
      await vi.waitFor(() => expect(snapshots).toContainEqual(['recovered-after-throw']))
    } finally {
      subscription.unsubscribe()
    }
  })

  it('emits one advisory while a registered provider remains unreachable', async () => {
    const transcriptPath = '/tmp/unreachable-provider-session.jsonl'
    const { provider, stat } = memoryProvider(new Map())
    stat.mockRejectedValue(Object.assign(new Error('connection lost'), { code: 'CONNECTION_LOST' }))
    mocks.getProvider.mockReturnValue(provider)
    const errors: (string | undefined)[] = []
    const subscription = await subscribeNativeChatTranscript({
      ...routedArgs(transcriptPath),
      onInitialSnapshot: (_messages, _hasMore, _beforeOffset, error) => errors.push(error),
      onAppend: () => {},
      resolvePollIntervalMs: 5
    })

    try {
      await vi.waitFor(() => expect(stat.mock.calls.length).toBeGreaterThanOrEqual(3))
      expect(errors).toEqual(['Transcript unverifiable on the remote host'])
    } finally {
      subscription.unsubscribe()
    }
  })

  it('keeps provider methods bound to their owning instance', async () => {
    const transcriptPath = '/tmp/bound-provider-session.jsonl'
    const provider = {
      files: new Map([[transcriptPath, Buffer.from(claudeLine('bound-remote', 'right host'))]]),
      async stat(this: { files: Map<string, Buffer> }, filePath: string): Promise<FileStat> {
        const bytes = this.files.get(filePath)!
        return { size: bytes.length, type: 'file', mtime: 1, mtimeMs: 1 }
      },
      async readFileRange(
        this: { files: Map<string, Buffer> },
        filePath: string,
        position: number,
        length: number
      ): Promise<FileRangeReadResult> {
        const bytes = this.files.get(filePath)!.subarray(position, position + length)
        return { bytes, bytesRead: bytes.length }
      },
      async supportsFileRangeRead() {
        return true
      }
    } as unknown as IFilesystemProvider
    mocks.getProvider.mockReturnValue(provider)

    const result = await readNativeChatTranscriptTail({
      ...routedArgs(transcriptPath),
      limit: 40
    })

    expect(result).toMatchObject({ messages: [{ id: 'bound-remote' }] })
  })
})

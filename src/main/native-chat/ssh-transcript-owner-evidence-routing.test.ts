import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileRangeReadResult, FileStat, IFilesystemProvider } from '../providers/types'

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn<(connectionId: string) => IFilesystemProvider | undefined>(),
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
    return provider ? { provider, generation: 1 } : null
  },
  onSshFilesystemProviderRegistered: () => () => undefined,
  onSshFilesystemProviderChanged: () => () => undefined,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE: 'Remote connection dropped.'
}))

import { readNativeChatTranscriptTail } from './transcript-tail-reader'
import { subscribeNativeChatTranscript } from './transcript-watch'

const SESSION_ID = 'session-ssh-owner'
const PANE_KEY = 'tab-owner:11111111-1111-4111-8111-111111111111'

function claudeLine(id: string, text: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid: id,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })}\n`
}

function memoryProvider(files: Map<string, Buffer>): IFilesystemProvider {
  return {
    stat: async (filePath: string): Promise<FileStat> => {
      const bytes = files.get(filePath)
      if (!bytes) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${filePath}'`), {
          code: 'ENOENT'
        })
      }
      return { size: bytes.length, type: 'file', mtime: 1, mtimeMs: 1, dev: 7, ino: 11 }
    },
    readFileRange: async (
      filePath: string,
      position: number,
      length: number
    ): Promise<FileRangeReadResult> => {
      const bytes = files.get(filePath)?.subarray(position, position + length)
      if (!bytes) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), {
          code: 'ENOENT'
        })
      }
      return { bytes, bytesRead: bytes.length }
    },
    supportsFileRangeRead: async () => true
  } as unknown as IFilesystemProvider
}

function retainedOwner(transcriptPath: string): Record<string, unknown> {
  return {
    paneKey: PANE_KEY,
    agentType: 'claude',
    sessionId: SESSION_ID,
    transcriptPath,
    connectionId: 'ssh-owner',
    observedAt: Date.now() - 30 * 24 * 60 * 60 * 1000
  }
}

let tempRoots: string[] = []

beforeEach(() => {
  mocks.getProvider.mockReset()
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

describe('SSH transcript owner evidence routing', () => {
  it('binds a subscription created before owner hydration once hydration completes', async () => {
    const transcriptPath = '/remote/pre-hydration.jsonl'
    mocks.getProvider.mockReturnValue(
      memoryProvider(
        new Map([
          [transcriptPath, Buffer.from(claudeLine('hydrated-remote', 'ready after hydrate'))]
        ])
      )
    )
    mocks.statusRows = [
      {
        paneKey: PANE_KEY,
        agentType: 'claude',
        connectionId: 'ssh-owner',
        providerSession: { key: 'session_id', id: SESSION_ID, transcriptPath }
      }
    ]
    let releaseHydration = (): void => {}
    mocks.awaitHydration = () =>
      new Promise<void>((resolve) => {
        releaseHydration = resolve
      })
    const snapshots: string[][] = []

    const pending = subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: SESSION_ID,
      paneKey: PANE_KEY,
      onInitialSnapshot: (messages) => snapshots.push(messages.map((message) => message.id)),
      onAppend: () => {}
    })
    expect(mocks.getProvider).not.toHaveBeenCalled()

    releaseHydration()
    const subscription = await pending
    try {
      await vi.waitFor(() => expect(snapshots).toContainEqual(['hydrated-remote']))
    } finally {
      subscription.unsubscribe()
    }
  })

  it('routes locator-free legacy reads from retained SSH owner evidence', async () => {
    const transcriptPath = '/remote/retained-session.jsonl'
    mocks.getProvider.mockReturnValue(
      memoryProvider(
        new Map([[transcriptPath, Buffer.from(claudeLine('retained-remote', 'retained owner'))]])
      )
    )
    mocks.retainedOwners = [retainedOwner(transcriptPath)]

    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: SESSION_ID,
      limit: 40
    })

    expect(result).toMatchObject({ messages: [{ id: 'retained-remote' }] })
  })

  it('fails locator-free legacy reads closed after retained SSH transport loss', async () => {
    mocks.retainedOwners = [retainedOwner('/remote/retained-session.jsonl')]

    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: SESSION_ID,
      limit: 40
    })

    expect(result).toEqual({ error: 'Transcript unverifiable on the remote host' })
  })

  it('blocks legacy local fallback while pre-ledger remote ownership is unresolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-unresolved-owner-'))
    tempRoots.push(root)
    const transcriptPath = join(root, 'session.jsonl')
    await writeFile(transcriptPath, claudeLine('desktop-poison', 'wrong host'))
    mocks.unresolvedOwner = true

    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: SESSION_ID,
      transcriptPath,
      limit: 40
    })

    expect(result).toEqual({ error: 'Transcript unverifiable on the remote host' })
    expect(mocks.getProvider).not.toHaveBeenCalled()
  })
})

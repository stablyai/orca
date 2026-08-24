import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import type { FileRangeReadResult, FileStat, IFilesystemProvider } from '../providers/types'

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn<(connectionId: string) => IFilesystemProvider | undefined>(),
  ownerListeners: new Set<() => void>(),
  statusRows: [] as Record<string, unknown>[]
}))

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    getStatusSnapshot: () => mocks.statusRows,
    getStatusSnapshotForPane: (paneKey: string) =>
      mocks.statusRows.filter((row) => row.paneKey === paneKey),
    getTranscriptOwnerEvidence: () => [],
    hasUnresolvedRemoteTranscriptOwner: () => false,
    awaitTranscriptOwnerHydration: () => Promise.resolve(),
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
    supportsFileRangeRead: async () => true
  } as unknown as IFilesystemProvider
  return { provider, readFile, readFileRange, stat }
}

beforeEach(() => {
  mocks.getProvider.mockReset()
  mocks.ownerListeners.clear()
  mocks.statusRows = []
})

describe('SSH transcript append range pagination', () => {
  it('pages a large append in bounded ranges without rereading the prefix', async () => {
    const transcriptPath = '/tmp/large-append-session.jsonl'
    const initial = Buffer.from(claudeLine('initial', 'first'))
    const files = new Map([[transcriptPath, initial]])
    const { provider, readFile, readFileRange, stat } = memoryProvider(files)
    stat.mockImplementation(async (filePath: string): Promise<FileStat> => {
      const bytes = files.get(filePath)!
      return {
        size: bytes.length,
        type: 'file',
        mtime: bytes.length,
        mtimeMs: bytes.length,
        dev: 7,
        ino: 11
      }
    })
    mocks.getProvider.mockReturnValue(provider)
    mocks.statusRows = [
      {
        paneKey: PANE_KEY,
        agentType: 'claude',
        connectionId: 'ssh-owner',
        providerSession: { key: 'session_id', id: SESSION_ID, transcriptPath }
      }
    ]
    const appended: string[] = []
    const replacements: string[][] = []
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: SESSION_ID,
      transcriptPath,
      paneKey: PANE_KEY,
      initialLimit: 40,
      onInitialSnapshot: () => {},
      onAppend: (messages) => appended.push(...messages.map((message) => message.id)),
      onReplace: (messages) => replacements.push(messages.map((message) => message.id)),
      debounceMs: 0,
      reconciliationIntervalMs: 20
    })

    try {
      await vi.waitFor(() => expect(readFileRange).toHaveBeenCalled())
      readFileRange.mockClear()
      const partial = Buffer.from('{"type":')
      files.set(transcriptPath, Buffer.concat([initial, partial]))
      await vi.waitFor(() =>
        expect(readFileRange).toHaveBeenCalledWith(
          transcriptPath,
          initial.length,
          partial.length,
          expect.anything()
        )
      )
      readFileRange.mockClear()
      const append = Buffer.from(
        Array.from({ length: 3_000 }, (_, index) =>
          claudeLine(`append-${index}`, `bounded remote append ${index}`)
        ).join('')
      )
      expect(append.length).toBeGreaterThan(MAX_FILE_RANGE_READ_BYTES)
      files.set(transcriptPath, Buffer.concat([initial, partial, append]))

      await vi.waitFor(() => expect(replacements.at(-1)).toContain('append-2999'))
      expect(replacements.at(-1)).toHaveLength(40)
      expect(appended).not.toContain('append-2999')
      const requestedLengths = readFileRange.mock.calls.map((call) => call[2])
      expect(Math.max(...requestedLengths)).toBeLessThanOrEqual(MAX_FILE_RANGE_READ_BYTES)
      expect(requestedLengths.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(
        append.length + 256
      )
      const afterReplacement = Buffer.from(claudeLine('after-replacement', 'still live'))
      files.set(transcriptPath, Buffer.concat([initial, partial, append, afterReplacement]))
      await vi.waitFor(() => expect(appended).toContain('after-replacement'), { timeout: 3_000 })
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      subscription.unsubscribe()
    }
  })
})

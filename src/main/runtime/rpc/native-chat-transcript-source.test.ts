import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IFilesystemProvider } from '../../providers/types'
import type { OrcaRuntimeService } from '../orca-runtime'

const getSshFilesystemProvider = vi.hoisted(() => vi.fn())

vi.mock('../../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider
}))

import { resolveNativeChatTranscriptSource } from './native-chat-transcript-source'

function runtimeWithBinding(
  binding: {
    worktreeId: string
    connectionId: string | null
    agent: string
    providerSession: { key: 'session_id'; id: string; transcriptPath?: string }
  } | null
): OrcaRuntimeService {
  return {
    resolveNativeChatTranscriptBinding: vi.fn(() => binding)
  } as unknown as OrcaRuntimeService
}

const params = {
  agent: 'claude' as const,
  sessionId: 'session-1',
  transcriptPath: '/remote/session.jsonl',
  worktreeId: 'worktree-1',
  terminal: 'terminal-1'
}

describe('native-chat transcript source authority', () => {
  beforeEach(() => {
    getSshFilesystemProvider.mockReset()
  })

  it('uses the runtime-owned binding for local transcript reads', () => {
    const runtime = runtimeWithBinding({
      worktreeId: 'worktree-1',
      connectionId: null,
      agent: 'claude',
      providerSession: {
        key: 'session_id',
        id: 'session-1',
        transcriptPath: '/remote/session.jsonl'
      }
    })

    expect(resolveNativeChatTranscriptSource(runtime, params)).toEqual({
      filePath: '/remote/session.jsonl'
    })
    expect(getSshFilesystemProvider).not.toHaveBeenCalled()
  })

  it('rejects a terminal, worktree, agent, session, or path mismatch', () => {
    const runtime = runtimeWithBinding({
      worktreeId: 'other-worktree',
      connectionId: 'ssh-1',
      agent: 'claude',
      providerSession: {
        key: 'session_id',
        id: 'session-1',
        transcriptPath: '/remote/session.jsonl'
      }
    })

    expect(() => resolveNativeChatTranscriptSource(runtime, params)).toThrow(
      'Transcript unavailable'
    )
    expect(getSshFilesystemProvider).not.toHaveBeenCalled()
  })

  it('revalidates authority and acquires the current SSH provider per reader', async () => {
    let binding = {
      worktreeId: 'worktree-1',
      connectionId: 'ssh-1',
      agent: 'claude',
      providerSession: {
        key: 'session_id' as const,
        id: 'session-1',
        transcriptPath: '/remote/session.jsonl'
      }
    }
    const runtime = {
      resolveNativeChatTranscriptBinding: vi.fn(() => binding)
    } as unknown as OrcaRuntimeService
    const firstProvider = {
      stat: vi.fn().mockResolvedValue({ type: 'file', size: 2, mtime: 1 })
    } as unknown as IFilesystemProvider
    const secondProvider = {
      readFileChunk: vi.fn().mockResolvedValue({
        contentBase64: Buffer.from('ok').toString('base64'),
        bytesRead: 2,
        eof: true
      })
    } as unknown as IFilesystemProvider
    getSshFilesystemProvider.mockReturnValueOnce(firstProvider).mockReturnValue(secondProvider)

    const resolved = resolveNativeChatTranscriptSource(runtime, params)
    await resolved.fileSource?.stat(resolved.filePath!)
    const reader = await resolved.fileSource?.open(resolved.filePath!)
    await expect(reader?.read(0, 2)).resolves.toEqual(Buffer.from('ok'))
    await reader?.close()

    expect(getSshFilesystemProvider).toHaveBeenCalledTimes(2)
    expect(runtime.resolveNativeChatTranscriptBinding).toHaveBeenCalledTimes(3)

    binding = { ...binding, connectionId: 'ssh-2' }
    await expect(resolved.fileSource?.stat(resolved.filePath!)).rejects.toThrow(
      'Transcript unavailable'
    )
    expect(getSshFilesystemProvider).toHaveBeenCalledTimes(2)
  })

  it('never falls back to the desktop filesystem while SSH is disconnected', async () => {
    const runtime = runtimeWithBinding({
      worktreeId: 'worktree-1',
      connectionId: 'ssh-1',
      agent: 'claude',
      providerSession: {
        key: 'session_id',
        id: 'session-1',
        transcriptPath: '/remote/session.jsonl'
      }
    })
    getSshFilesystemProvider.mockReturnValue(undefined)

    const resolved = resolveNativeChatTranscriptSource(runtime, params)
    await expect(resolved.fileSource?.stat(resolved.filePath!)).rejects.toThrow(
      'Transcript unavailable'
    )
  })
})

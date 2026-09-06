import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import * as sshFilesystemDispatch from '../../providers/ssh-filesystem-dispatch'
import * as workerTranscriptRead from './worker-transcript-read'
import { captureWorkerOutputArchive, summarizeWorkerOutputArchive } from './worker-output-archive'

describe('worker output archive summary', () => {
  it('reports a draft-only terminal archive as captured', () => {
    expect(
      summarizeWorkerOutputArchive({
        kind: 'terminal_tail',
        content: JSON.stringify({
          lines: [],
          draft: 'final partial line',
          truncated: false,
          terminalStatus: 'running',
          warnings: []
        })
      } as never)
    ).toEqual({ source: 'terminal', status: 'captured' })
  })
})

function codexMessage(id: string, text: string): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: { id, type: 'agent_message', message: text }
  })
}

describe('worker output archive WSL routing', () => {
  let directory: string
  let transcriptPath: string
  let sshProviderLookup: { mockRestore: () => void }
  let transcriptReadSpy: { mockRestore: () => void } | undefined

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-worker-archive-'))
    transcriptPath = join(directory, 'session.jsonl')
    await writeFile(transcriptPath, `${codexMessage('wsl', 'WSL archive output')}\n`)
    sshProviderLookup = vi.spyOn(sshFilesystemDispatch, 'getSshFilesystemProvider')
  })

  afterEach(async () => {
    sshProviderLookup.mockRestore()
    transcriptReadSpy?.mockRestore()
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps WSL relay sessions on the local guarded transcript resolver', async () => {
    const guestTranscriptPath = '/home/ada/.codex/sessions/rollout-wsl.jsonl'
    transcriptReadSpy = vi.spyOn(workerTranscriptRead, 'readWorkerTranscript').mockResolvedValue({
      ok: true,
      filePath: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\rollout-wsl.jsonl',
      sourceFingerprint: 'wsl-source',
      boundaryCheckpoint: 'wsl-boundary',
      messages: [
        {
          id: 'wsl',
          role: 'assistant',
          timestamp: 0,
          source: 'transcript',
          blocks: [{ type: 'text', text: 'WSL archive output' }]
        }
      ],
      nextOffset: 42,
      limited: false,
      clipping: [],
      warnings: []
    })
    const session = {
      paneKey: 'tab:worker',
      processIncarnation: 'pty:wsl-incarnation',
      connectionId: 'wsl:Ubuntu',
      wslDistro: 'Ubuntu',
      agent: 'codex' as const,
      providerSession: {
        key: 'session_id',
        id: 'wsl-session',
        transcriptPath: guestTranscriptPath
      },
      observedAt: Date.now()
    }
    const runtime = {
      getExactWorkerProviderSession: vi.fn(() => session),
      readTerminal: vi.fn()
    } as unknown as OrcaRuntimeService

    const result = await captureWorkerOutputArchive({
      runtime,
      dispatchId: 'dispatch-wsl',
      terminalHandle: 'term-wsl',
      attachedAtMs: Date.now() - 1
    })

    expect(workerTranscriptRead.readWorkerTranscript).toHaveBeenCalledWith({
      agent: 'codex',
      sessionId: 'wsl-session',
      transcriptPath: guestTranscriptPath,
      wslDistro: 'Ubuntu',
      limit: expect.any(Number),
      filesystemProvider: undefined
    })
    expect(result).toMatchObject({
      kind: 'transcript_pin',
      status: 'captured',
      content: {
        messages: [{ id: 'wsl', blocks: [{ type: 'text', text: 'WSL archive output' }] }]
      }
    })
    expect(sshProviderLookup).not.toHaveBeenCalled()
  })

  it('does not resolve an SSH transcript locally when its provider is unavailable', async () => {
    vi.mocked(sshFilesystemDispatch.getSshFilesystemProvider).mockReturnValue(undefined)
    transcriptReadSpy = vi.spyOn(workerTranscriptRead, 'readWorkerTranscript')
    const runtime = {
      getExactWorkerProviderSession: vi.fn(() => ({
        paneKey: 'tab:ssh-worker',
        processIncarnation: 'pty:ssh-incarnation',
        connectionId: 'ssh:remote-host',
        agent: 'codex' as const,
        providerSession: {
          key: 'session_id',
          id: 'ssh-session',
          transcriptPath: '/home/ada/.codex/sessions/rollout-ssh.jsonl'
        },
        observedAt: Date.now()
      })),
      readTerminal: vi.fn().mockResolvedValue({
        tail: ['remote worker terminal fallback'],
        truncated: false,
        status: 'live'
      })
    } as unknown as OrcaRuntimeService

    const result = await captureWorkerOutputArchive({
      runtime,
      dispatchId: 'dispatch-ssh',
      terminalHandle: 'term-ssh',
      attachedAtMs: Date.now() - 1
    })

    expect(sshFilesystemDispatch.getSshFilesystemProvider).toHaveBeenCalledWith('ssh:remote-host')
    expect(workerTranscriptRead.readWorkerTranscript).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      kind: 'terminal_tail',
      status: 'captured',
      content: {
        lines: ['remote worker terminal fallback'],
        fallbackReason: 'remote_capability_unavailable'
      }
    })
  })

  it('labels an exact empty transcript without claiming the session was unreported', async () => {
    transcriptReadSpy = vi.spyOn(workerTranscriptRead, 'readWorkerTranscript').mockResolvedValue({
      ok: true,
      filePath: transcriptPath,
      sourceFingerprint: 'empty-source',
      boundaryCheckpoint: 'empty-boundary',
      messages: [],
      nextOffset: 0,
      limited: false,
      clipping: [],
      warnings: []
    })
    const runtime = {
      getExactWorkerProviderSession: vi.fn(() => ({
        paneKey: 'tab:worker',
        processIncarnation: 'pty:incarnation',
        agent: 'codex' as const,
        providerSession: {
          key: 'session_id',
          id: 'empty-session',
          transcriptPath
        },
        observedAt: Date.now()
      })),
      readTerminal: vi.fn().mockResolvedValue({
        tail: ['terminal fallback'],
        truncated: false,
        status: 'running'
      })
    } as unknown as OrcaRuntimeService

    const result = await captureWorkerOutputArchive({
      runtime,
      dispatchId: 'dispatch-empty',
      terminalHandle: 'term-empty',
      attachedAtMs: Date.now() - 1
    })

    expect(result).toMatchObject({
      kind: 'terminal_tail',
      content: { fallbackReason: 'transcript_empty' }
    })
  })
})

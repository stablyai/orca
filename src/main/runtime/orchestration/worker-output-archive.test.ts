import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import * as workerTranscriptRead from './worker-transcript-read'
import { captureWorkerOutputArchive } from './worker-output-archive'

function codexMessage(id: string, text: string): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: { id, type: 'agent_message', message: text }
  })
}

describe('worker output archive WSL routing', () => {
  let directory: string
  let transcriptPath: string
  let transcriptReadSpy: { mockRestore: () => void } | undefined

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-worker-archive-'))
    transcriptPath = join(directory, 'session.jsonl')
    await writeFile(transcriptPath, `${codexMessage('wsl', 'WSL archive output')}\n`)
  })

  afterEach(async () => {
    transcriptReadSpy?.mockRestore()
    await rm(directory, { recursive: true, force: true })
  })

  it('does not resolve an SSH transcript locally', async () => {
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

    expect(workerTranscriptRead.readWorkerTranscript).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      kind: 'terminal_tail',
      status: 'captured',
      content: {
        lines: ['remote worker terminal fallback'],
        fallbackReason: 'remote_capability_unavailable',
        warnings: expect.arrayContaining([
          'The terminal read did not identify an authoritative screen; available terminal output was preserved.',
          'Terminal wrap information was unavailable; capability masking used complete lines.'
        ])
      }
    })
  })
})

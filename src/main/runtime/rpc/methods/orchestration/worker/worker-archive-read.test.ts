import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExactWorkerProviderSession } from '../../../../../../shared/orchestration/workers/orchestration-worker-output'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import {
  captureWorkerOutputReference,
  releaseCommitFieldsForCapturedArchive
} from '../../../../orchestration/workers/archives/worker-output-archive'

// Resolve only the exact file, so a missing transcript never falls back to this machine's agent homes.
vi.mock('../../../../../native-chat/session-file-resolver', () => ({
  resolveSessionFilePath: async (
    _agent: string,
    _sessionId: string,
    options: { transcriptPath?: string }
  ) =>
    options.transcriptPath && existsSync(options.transcriptPath) ? options.transcriptPath : null
}))

const { readArchivedWorkerOutput } = await import('./worker-archive-read')

function codexMessage(id: string, text: string): string {
  return JSON.stringify({
    timestamp: '2026-11-11T12:00:00.000Z',
    type: 'event_msg',
    payload: { id, type: 'agent_message', message: text }
  })
}

const RELEASED = { id: 'res_1', terminal_handle: 'term_1', release_state: 'released' } as const

describe('reading a released terminal worker', () => {
  let directory: string
  let transcriptPath: string
  let db: OrchestrationDb

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-released-worker-'))
    transcriptPath = join(directory, 'rollout-worker.jsonl')
    await writeFile(transcriptPath, `${codexMessage('m1', 'the final answer')}\n`)
    db = new OrchestrationDb(':memory:')
  })

  afterEach(async () => {
    db.close()
    await rm(directory, { recursive: true, force: true })
  })

  function release(session: Partial<ExactWorkerProviderSession> | null): void {
    const captured = captureWorkerOutputReference({
      runtime: {
        getExactWorkerProviderSession: () =>
          session && {
            paneKey: 'tab_1:leaf',
            processIncarnation: 'pty:1',
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'session-1', transcriptPath },
            observedAt: 1,
            ...session
          }
      },
      terminalHandle: 'term_1',
      attachedAtMs: 0
    })
    const { kind, content } = releaseCommitFieldsForCapturedArchive(captured)
    db.storeWorkerTerminalArchive({ dispatchId: 'ctx_1', resourceId: 'res_1', kind, content })
  }

  const read = () =>
    readArchivedWorkerOutput({
      db,
      dispatchId: 'ctx_1',
      workerState: 'succeeded',
      resource: RELEASED
    })

  it('reads its transcript from the original file, keeping no copy', async () => {
    release({})

    await expect(read()).resolves.toMatchObject({
      source: 'transcript',
      archived: true,
      transcript: {
        messages: [{ id: 'm1', blocks: [{ type: 'text', text: 'the final answer' }] }]
      },
      status: { liveness: 'exited' }
    })
    expect(db.getWorkerTerminalArchive('ctx_1')?.content).not.toContain('the final answer')
  })

  it('says the output is no longer available once the original is gone', async () => {
    release({})
    await rm(transcriptPath)

    await expect(read()).rejects.toMatchObject({
      code: 'archive_unavailable',
      message: expect.stringContaining('See its report (worker_done) or task result.')
    })
  })

  it('says the output is unavailable for a worker whose transcript was never reachable', async () => {
    release({ connectionId: 'ssh:remote-host' })

    expect(db.getWorkerTerminalArchive('ctx_1')?.kind).toBe('terminal_tail')
    await expect(read()).rejects.toMatchObject({
      code: 'archive_unavailable',
      message: expect.stringContaining('remote_capability_unavailable')
    })
  })

  it('records no transcript for an agent whose transcript the reader cannot open', async () => {
    release({ agent: 'opencode' })

    expect(db.getWorkerTerminalArchive('ctx_1')?.kind).toBe('terminal_tail')
    await expect(read()).rejects.toMatchObject({
      code: 'archive_unavailable',
      message: expect.stringContaining('provider_unsupported')
    })
  })

  it('keeps serving the saved copy of a row released before references', async () => {
    db.storeWorkerTerminalArchive({
      dispatchId: 'ctx_1',
      resourceId: 'res_1',
      kind: 'transcript_pin',
      content: JSON.stringify({
        version: 2,
        agent: 'codex',
        processIncarnation: 'pty:1',
        messages: [
          { id: 'old', role: 'assistant', blocks: [{ type: 'text', text: 'saved copy' }] }
        ],
        limited: false,
        warnings: []
      })
    })

    const output = JSON.stringify(await read())

    expect(output).toContain('saved copy')
    expect(output).not.toContain('the final answer')
  })
})

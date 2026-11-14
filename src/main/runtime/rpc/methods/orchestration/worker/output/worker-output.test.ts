import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import { readExactWorkerOutput } from './worker-output'

function codexMessage(id: string, text: string): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: { id, type: 'agent_message', message: text }
  })
}

describe('exact orchestration worker output', () => {
  let directory: string
  let transcriptA: string
  let providerSession: ReturnType<OrcaRuntimeService['getExactWorkerProviderSession']>
  let runtime: OrcaRuntimeService
  const readTerminal = vi.fn()

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-worker-output-'))
    transcriptA = join(directory, 'session-a.jsonl')
    await writeFile(transcriptA, `${codexMessage('a', 'worker A only')}\n`)
    providerSession = {
      paneKey: 'tab:worker',
      processIncarnation: 'pty:incarnation-1',
      agent: 'codex',
      providerSession: {
        key: 'session_id',
        id: 'session-a',
        transcriptPath: transcriptA
      },
      observedAt: Date.now()
    }
    readTerminal.mockReset()
    readTerminal.mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['terminal output'],
      truncated: false,
      nextCursor: '9'
    })
    runtime = {
      getExactWorkerProviderSession: vi.fn(() => providerSession),
      getTerminalProcessIncarnation: vi.fn(() => 'pty:incarnation-1'),
      getTerminalPaneKey: vi.fn(() => 'tab:worker'),
      readTerminal
    } as unknown as OrcaRuntimeService
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const read = (overrides: Partial<Parameters<typeof readExactWorkerOutput>[0]> = {}) =>
    readExactWorkerOutput({
      runtime,
      dispatchId: 'dispatch_1',
      terminalHandle: 'term_worker',
      workerState: 'ready',
      terminalStatus: 'running',
      attachedAt: '2026-07-24 00:00:00',
      ...overrides
    })

  it('rejects an old cursor after a same-inode truncate/regrow', async () => {
    const initial = await read()
    if (initial.source !== 'transcript') {
      throw new Error('Expected transcript output')
    }
    const before = await stat(transcriptA, { bigint: true })
    await writeFile(
      transcriptA,
      `${codexMessage('replacement', 'unrelated transcript')}\n${' '.repeat(512)}`
    )
    const after = await stat(transcriptA, { bigint: true })
    expect(after.ino).toBe(before.ino)
    expect(after.dev).toBe(before.dev)
    const fresh = await read()
    if (fresh.source !== 'transcript') {
      throw new Error('Expected replacement transcript output')
    }
    expect(fresh.sourceIdentity).toBe(initial.sourceIdentity)

    await expect(read({ cursor: initial.cursor })).rejects.toMatchObject({
      code: 'source_changed'
    })
  })
})

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
  let transcriptB: string
  let providerSession: ReturnType<OrcaRuntimeService['getExactWorkerProviderSession']>
  let runtime: OrcaRuntimeService
  const readTerminal = vi.fn()

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-worker-output-'))
    transcriptA = join(directory, 'session-a.jsonl')
    transcriptB = join(directory, 'session-b.jsonl')
    await writeFile(transcriptA, `${codexMessage('a', 'worker A only')}\n`)
    await writeFile(transcriptB, `${codexMessage('b', 'worker B only')}\n`)
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

  it('reads only the exact pane session and keeps its local path private', async () => {
    const result = await read()

    expect(result).toMatchObject({
      source: 'transcript',
      provider: 'codex',
      transcript: {
        messages: [{ id: 'a', blocks: [{ type: 'text', text: 'worker A only' }] }]
      }
    })
    expect(JSON.stringify(result)).not.toContain(transcriptA)
    expect(JSON.stringify(result)).not.toContain('worker B only')
    expect(readTerminal).not.toHaveBeenCalled()
  })

  it('labels OpenCode as a terminal fallback when no transcript decoder exists', async () => {
    const capability = `dcap_${'A'.repeat(43)}`
    readTerminal.mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: [`opencode --dispatch-capability ${capability}`],
      truncated: false,
      nextCursor: '9'
    })
    providerSession = {
      ...providerSession!,
      agent: 'opencode',
      providerSession: {
        key: 'session_id',
        id: 'session-opencode',
        transcriptPath: transcriptA
      }
    }

    const result = await read()

    expect(result).toMatchObject({
      source: 'terminal',
      fallbackReason: 'provider_unsupported',
      terminal: { tail: ['opencode --dispatch-capability [dispatch capability redacted]'] },
      warnings: [
        'Dispatch capability tokens were redacted from terminal output.',
        'Terminal wrap information was unavailable; capability masking used complete lines.'
      ]
    })
    expect(JSON.stringify(result)).not.toContain(capability)
  })

  it('redacts dispatch capabilities from terminal composer drafts', async () => {
    const capability = `dcap_${'A'.repeat(43)}`
    readTerminal.mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['safe output'],
      draft: `send --dispatch-capability ${capability}`,
      truncated: false,
      nextCursor: '9'
    })
    providerSession = null

    const result = await read()

    expect(result).toMatchObject({
      source: 'terminal',
      terminal: {
        tail: ['safe output'],
        draft: 'send --dispatch-capability [dispatch capability redacted]'
      },
      warnings: [
        'Dispatch capability tokens were redacted from terminal output.',
        'Terminal wrap information was unavailable; capability masking used complete lines.'
      ]
    })
    expect(JSON.stringify(result)).not.toContain(capability)
  })

  it('rejects an old cursor after the exact provider session changes', async () => {
    const initial = await read()
    if (initial.source !== 'transcript') {
      throw new Error('Expected transcript output')
    }
    providerSession = {
      ...providerSession!,
      providerSession: {
        key: 'session_id',
        id: 'session-b',
        transcriptPath: transcriptB
      }
    }

    await expect(read({ cursor: initial.cursor })).rejects.toMatchObject({
      code: 'source_changed'
    })
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

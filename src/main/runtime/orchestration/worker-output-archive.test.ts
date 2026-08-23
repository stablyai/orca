import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import { captureWorkerOutputArchive } from './worker-output-archive'

describe('worker output archive', () => {
  it('bounds and capability-redacts archived commands', async () => {
    const capability = `dcap_${'a'.repeat(20)}`
    const runtime = {
      getExactWorkerProviderSession: vi.fn().mockReturnValue(null),
      readTerminal: vi.fn().mockResolvedValue({
        handle: 'term_worker',
        status: 'exited',
        tail: ['final output'],
        truncated: false,
        command: `codex --dispatch-capability ${capability} ${'x'.repeat(5_000)}`
      })
    } as unknown as OrcaRuntimeService

    const archive = await captureWorkerOutputArchive({
      runtime,
      dispatchId: 'dispatch_worker',
      terminalHandle: 'term_worker',
      attachedAtMs: 1
    })

    expect(archive.kind).toBe('terminal_tail')
    if (archive.kind !== 'terminal_tail') {
      throw new Error('Expected terminal archive')
    }
    expect(archive.content.command).toHaveLength(4_096)
    expect(archive.content.command).not.toContain(capability)
    expect(archive.content.warnings).toEqual([
      'Dispatch capability tokens were redacted from the command.',
      'The archived terminal command was clipped to its size limit.'
    ])
  })
})

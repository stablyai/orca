import { describe, expect, it } from 'vitest'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import { OMP_ACP_DIALECT } from './omp-dialect'

const text = (value: string) => ({
  type: 'content' as const,
  content: { type: 'text' as const, text: value }
})
const normalize = (update: ToolCallUpdate) => OMP_ACP_DIALECT.normalizeToolUpdate!(update)

describe('OMP tool updates', () => {
  it('leaves a tool without a command echo as it came', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: 'file body' }], details: {} },
      content: [text('file body')]
    }
    expect(normalize(update)).toBe(update)
  })

  it('keeps a result that itself starts with "$ "', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: '$ 5.00' }], details: {} },
      content: [text('$ 5.00')]
    }
    expect(normalize(update)).toBe(update)
  })

  it.each([0, 3])('keeps an exit %s notice when OMP sent no matching detail', (code) => {
    const output = `done\n\nCommand exited with code ${code}`
    const update = normalize({
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: {
        content: [{ type: 'text', text: output }],
        details: { wallTimeMs: 12 }
      },
      content: [text('$ ./run'), text(output)]
    })
    expect(update).toMatchObject({
      content: [],
      rawOutput: { stdout: output, exitCode: 0 }
    })
  })

  const command = (
    status: ToolCallUpdate['status'],
    details: Record<string, unknown>,
    rawInput?: unknown
  ): ToolCallUpdate => ({
    toolCallId: 'call-1',
    status,
    ...(rawInput === undefined ? {} : { rawInput }),
    rawOutput: { content: [{ type: 'text', text: 'ok' }], details },
    content: [text('$ ./run'), text('ok')]
  })

  it('shows exit 0 for a foreground command that completed, since OMP omits a zero exit', () => {
    expect(normalize(command('completed', { wallTimeMs: 12 })).rawOutput).toMatchObject({
      stdout: 'ok',
      exitCode: 0
    })
    expect(
      normalize(command('completed', { wallTimeMs: 0, signal: null })).rawOutput
    ).toMatchObject({
      exitCode: 0
    })
  })

  it('infers no exit code for a command that is running, timed out, signalled or in the background', () => {
    for (const update of [
      command('in_progress', { wallTimeMs: 12 }),
      command('completed', { wallTimeMs: 12, timedOut: true }),
      command('completed', { wallTimeMs: 12, signal: 'SIGTERM' }),
      command('completed', { wallTimeMs: 12, async: { jobId: 'job-1' } }),
      command('completed', { wallTimeMs: 12 }, { command: './run', async: true })
    ]) {
      expect(normalize(update).rawOutput).not.toHaveProperty('exitCode')
    }
  })

  it('infers no exit code without foreground timing metadata', () => {
    for (const details of [undefined, {}, { signal: null }]) {
      const update = normalize({
        toolCallId: 'call-1',
        status: 'completed',
        rawOutput: { content: [{ type: 'text', text: 'ok' }], ...(details ? { details } : {}) },
        content: [text('$ ./run'), text('ok')]
      })
      expect(update.rawOutput).toMatchObject({ stdout: 'ok' })
      expect(update.rawOutput).not.toHaveProperty('exitCode')
    }
  })

  it('does not confuse OMP v18.4 service-start completion with a process exit', () => {
    for (const timing of [{}, { wallTimeMs: 12 }]) {
      const update = normalize({
        toolCallId: 'service-call',
        status: 'completed',
        rawOutput: {
          content: [{ type: 'text', text: 'web: running pid=123 ready' }],
          details: {
            ...timing,
            service: { name: 'web', state: 'running', ready: true, timedOut: false, pid: 123 }
          }
        },
        content: [text('$ python3 -m http.server 8765'), text('web: running pid=123 ready')]
      })
      expect(update.rawOutput).toMatchObject({ stdout: 'web: running pid=123 ready' })
      expect(update.rawOutput).not.toHaveProperty('exitCode')
    }
  })

  it('leaves an existing generic command result intact', () => {
    for (const result of [
      { exitCode: 3 },
      { exit_code: 3 },
      { stdout: 'original' },
      { stderr: 'error' },
      { output_for_prompt: 'original' },
      { signal: 'SIGTERM' },
      { timed_out: true }
    ]) {
      const update = command('completed', { wallTimeMs: 12 })
      update.rawOutput = {
        ...result,
        content: [{ type: 'text', text: 'ok' }],
        details: { wallTimeMs: 12 }
      }
      expect(normalize(update)).toBe(update)
    }
  })

  it("keeps a failed command's reported exit code", () => {
    const update = normalize({
      toolCallId: 'call-1',
      status: 'failed',
      rawOutput: {
        content: [{ type: 'text', text: 'hi\n\nCommand exited with code 3' }],
        details: { exitCode: 3 }
      },
      content: [text('$ ./run'), text('hi\n\nCommand exited with code 3')]
    })
    expect(update.rawOutput).toMatchObject({ stdout: 'hi', exitCode: 3 })
  })
})

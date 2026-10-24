import { describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

import { renderD2Diagram } from './d2-render'

const success: ProcessResult = {
  code: 0,
  signal: null,
  stdout: '<svg></svg>',
  stderr: 'success: successfully compiled - to - in 5ms',
  timedOut: false
}

function render(result: Partial<ProcessResult>, source = 'a -> b') {
  const runCommand = vi.fn(async (_spec: ProcessSpec) => ({ ...success, ...result }))
  const resolveCommand = vi.fn(async () => '/usr/local/bin/d2')
  return {
    runCommand,
    result: renderD2Diagram({ source, isDark: true }, { runCommand, resolveCommand })
  }
}

describe('renderD2Diagram', () => {
  it('pipes the source to the resolved d2 binary and returns its SVG', async () => {
    const { runCommand, result } = render({})
    expect(await result).toEqual({ ok: true, svg: '<svg></svg>' })
    const spec = runCommand.mock.calls[0][0]
    expect(spec.program).toBe('/usr/local/bin/d2')
    expect(spec.input).toBe('a -> b')
    expect(spec.args).toEqual(expect.arrayContaining(['--theme', '200', '--bundle=false', '-']))
    expect(spec.killOnOutputLimit).toBe(true)
  })

  it('reports a missing binary without spawning', async () => {
    const runCommand = vi.fn()
    const result = await renderD2Diagram(
      { source: 'a', isDark: false },
      { runCommand, resolveCommand: async () => null }
    )
    expect(result).toEqual({ ok: false, reason: 'missing' })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('keeps only the position and message of d2 compile errors', async () => {
    const stderr =
      'err: failed to compile -: -:1:1: connection missing destination\n' +
      'err: -:2:1: invalid text beginning unquoted key\n'
    expect(await render({ code: 1, stdout: '', stderr }).result).toEqual({
      ok: false,
      reason: 'error',
      message: '1:1: connection missing destination\n2:1: invalid text beginning unquoted key'
    })
  })

  it('turns timeouts, oversized output and oversized source into errors', async () => {
    expect(await render({ timedOut: true }).result).toMatchObject({ message: 'd2 timed out' })
    expect(await render({ outputTruncated: true }).result).toMatchObject({
      message: 'Diagram output is too large'
    })
    const { runCommand, result } = render({}, 'x'.repeat(256 * 1024 + 1))
    expect(await result).toMatchObject({ message: 'Diagram source is too large' })
    expect(runCommand).not.toHaveBeenCalled()
  })
})

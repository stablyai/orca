import { describe, expect, it } from 'vitest'
import { DROID_ACP_DIALECT } from './droid-dialect'

const normalize = DROID_ACP_DIALECT.normalizeToolUpdate!

function execute(status: 'completed' | 'failed', rawOutput: string) {
  return normalize({
    toolCallId: 'call_execute',
    status,
    rawOutput,
    content: [{ type: 'content', content: { type: 'text', text: rawOutput } }]
  })
}

// Payloads recorded from Droid 1.16.0 over `droid exec --output-format acp`.
describe('DROID_ACP_DIALECT.normalizeToolUpdate', () => {
  it('reads shell output and exit code without the exit lines', () => {
    const failed = execute(
      'failed',
      'Error: Command failed (exit code: 1)\nhi\nls: nope-missing: No such file or directory\n\n\n[Process exited with code 1]'
    )
    expect(failed.rawOutput).toEqual({
      stdout: 'hi\nls: nope-missing: No such file or directory',
      exitCode: 1
    })
    expect(failed.content).toEqual([])
    expect(execute('completed', 'hi\nthere\n\n\n[Process exited with code 0]').rawOutput).toEqual({
      stdout: 'hi\nthere',
      exitCode: 0
    })
    expect(
      execute('completed', 'Command completed successfully\n\n[Process exited with code 0]')
        .rawOutput
    ).toEqual({ stdout: '', exitCode: 0 })
  })
})

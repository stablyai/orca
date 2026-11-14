import { describe, expect, it } from 'vitest'
import { COPILOT_ACP_DIALECT } from './copilot-dialect'

const normalize = COPILOT_ACP_DIALECT.normalizeToolUpdate!

// Payloads recorded from Copilot CLI 1.0.109 over `copilot --acp`.
describe('COPILOT_ACP_DIALECT.normalizeToolUpdate', () => {
  it('reads shell output and exit code without the shell trailer', () => {
    const update = normalize({
      toolCallId: 'call_shell',
      status: 'completed',
      rawOutput: {
        content: 'note.txt\nout.txt\n<shellId: 0 completed with exit code 3>',
        detailedContent: 'note.txt\nout.txt\n<shellId: 0 completed with exit code 3>',
        contents: [{ type: 'shell_exit', shellId: '0', exitCode: 3, cwd: '/tmp/work' }]
      },
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'note.txt\nout.txt\n<shellId: 0 completed with exit code 3>'
          }
        }
      ]
    })
    expect(update.rawOutput).toEqual({ stdout: 'note.txt\nout.txt', exitCode: 3 })
    expect(update.content).toEqual([])
  })
})

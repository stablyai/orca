import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService, join } from '../orca-runtime-test-mocks.spec'
import { store, syncSinglePty } from '../orca-runtime-test-fixtures.spec'
import {
  clearNativeWindowsConptyPty,
  markNativeWindowsConptyPty
} from '../terminal-model-query-authority'

// Real pwsh 7.6 + ConPTY bytes: PSReadLine paints a history prediction (another shell's command)
// as grey ghost text, then ConPTY overwrites it with absolute cursor moves as the user types.
const PSREADLINE_PREDICTION_TRANSCRIPT = readFileSync(
  join(__dirname, '..', '__fixtures__', 'pwsh-7-6-psreadline-history-prediction-conpty.txt'),
  'utf8'
)
const PROMPT = 'PS C:\\Users\\user\\orca\\workspaces\\orca\\run-ownership-validation>'

function startConptyRuntime(ptyId: string): InstanceType<typeof OrcaRuntimeService> {
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => ({ cols: 120, rows: 30 })
  })
  syncSinglePty(runtime, ptyId)
  return runtime
}

describe('OrcaRuntimeService ConPTY stream reads', () => {
  it('does not read PSReadLine history prediction ghost text as this terminal’s input', async () => {
    const ptyId = 'pty-conpty-prediction'
    markNativeWindowsConptyPty(ptyId)
    try {
      const runtime = startConptyRuntime(ptyId)
      const [terminal] = (await runtime.listTerminals()).terminals
      runtime.onPtyData(ptyId, PSREADLINE_PREDICTION_TRANSCRIPT, 100)

      const read = await runtime.readTerminal(terminal.handle)

      expect(read.tail.join('\n')).not.toContain('FOREIGN_LANE_COMMAND')
      expect(read.tail.join('\n')).not.toContain('other.py')
      expect(read.tail).toEqual([`${PROMPT} Write-Output OWN_MARKER`, 'OWN_MARKER', PROMPT])
    } finally {
      clearNativeWindowsConptyPty(ptyId)
    }
  })

  it('fills the requested line count even when blank rows sit below the prompt', async () => {
    const ptyId = 'pty-conpty-limit'
    markNativeWindowsConptyPty(ptyId)
    try {
      const runtime = startConptyRuntime(ptyId)
      const [terminal] = (await runtime.listTerminals()).terminals
      const output = Array.from({ length: 40 }, (_, index) => `line-${index}\r\n`).join('')
      runtime.onPtyData(ptyId, output, 100)

      const read = await runtime.readTerminal(terminal.handle, { limit: 3 })

      expect(read.tail).toEqual(['line-37', 'line-38', 'line-39'])
    } finally {
      clearNativeWindowsConptyPty(ptyId)
    }
  })

  it('keeps accumulated-stream reads for terminals that are not ConPTY', async () => {
    const ptyId = 'pty-posix-prediction'
    const runtime = startConptyRuntime(ptyId)
    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData(ptyId, 'one\r\ntwo\rTWO\r\n', 100)

    const read = await runtime.readTerminal(terminal.handle)

    expect(read.tail).toEqual(['one', 'TWO'])
    expect(read.source).toBe('stream')
  })
})

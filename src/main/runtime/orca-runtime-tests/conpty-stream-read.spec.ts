import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { join } from 'node:path'
import { store, syncSinglePty } from './orca-runtime-test-fixtures.spec'
import {
  clearNativeWindowsConptyPty,
  markNativeWindowsConptyPty
} from '../terminal/output/terminal-model-query-authority'

// Captured pwsh 7.6/ConPTY: grey PSReadLine predictions from history are overwritten by absolute cursor moves.
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
})

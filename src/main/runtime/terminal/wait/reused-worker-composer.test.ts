import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { waitForWorkerAgentReady } from './launched-agent-composer-readiness'

// oxlint-disable-next-line no-control-regex -- OSC title sequences start with ESC and end with BEL or ST.
const OSC_TITLE = /\x1b\][012];[^\x07\x1b]*(?:\x07|\x1b\\)/g

// Real Claude Code 2.1.291 capture ending at its empty composer (cursor at row 37, col 3), with
// Claude's own titles removed so only the shell wrapper's `env` title names the pane.
const claudeIdleCapture = readFileSync(
  join(__dirname, '../../__fixtures__/claude-interrupt-idle-usage-supported.txt'),
  'utf8'
).replace(OSC_TITLE, '')

it(
  'accepts a reused Claude composer painted before dispatch under a shell wrapper title',
  async () => {
    const runtime = new OrcaRuntimeService()
    const ptyId = 'pty-worker'
    const handle = 'term_worker'
    runtime.setPtyController({
      write: () => false,
      kill: () => false,
      getForegroundProcess: async () => 'claude',
      getSize: () => ({ cols: 120, rows: 40 })
    })
    runtime.registerPty(ptyId, 'workspace')
    runtime.registerPreAllocatedHandleForPty(ptyId, handle)
    try {
      runtime.onPtyData(ptyId, `\x1b]0;env\x07\x1b]133;C\x07${claudeIdleCapture}\x1b[37;3Hdraft`, 1)
      await runtime.serializeHiddenOutputRecoveryBuffer(ptyId)
      expect(await runtime.isTerminalRunningSettledPromptAgent(handle)).toBe(true)
      const waitForReuse = (timeoutMs: number) =>
        waitForWorkerAgentReady(runtime, handle, {
          reusesTerminal: true,
          agent: undefined,
          timeoutMs
        })
      await expect(waitForReuse(50)).rejects.toThrow('timeout')
      runtime.onPtyData(ptyId, '\x1b[37;3H\x1b[K', 2)
      await runtime.serializeHiddenOutputRecoveryBuffer(ptyId)
      // Why a wait budget under the test timeout: a regression then fails on this assertion.
      await expect(waitForReuse(3_000)).resolves.toMatchObject({
        satisfied: true,
        status: 'running'
      })
    } finally {
      await runtime.onPtyExit(ptyId, 0)
    }
  },
  // Real PTY bookkeeping plus a 3s reuse wait exceed the default 5s test timeout.
  10_000
)

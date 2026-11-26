import { expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { sendRestartContinuePrompt } from '../../construction/orca-runtime-terminal-worker-restart-resume'

const COMPOSER = '\x1b[?2004h\x1b[?1049h› Ask Codex to do anything\r\n'
// Codex's hooks review, opening over a brief that was already pasted.
const DIALOG =
  '\x1b[2J\x1b[HCodex found new hooks in this project.\r\n› 1. Trust and run them\r\n  2. Skip\r\nPress enter to continue\r\n\x1b[?25h'

// Codex turns on any-motion mouse tracking, so a hover over its pane sends this as the user's input.
const HOVER_REPORT = '\x1b[<35;40;12M'

it.each([
  { prompt: 'brief', dialog: false, input: null, enter: true },
  { prompt: 'brief', dialog: true, input: null, enter: false },
  { prompt: 'brief', dialog: false, input: HOVER_REPORT, enter: true },
  { prompt: 'brief', dialog: false, input: 'x', enter: false },
  { prompt: 'restart continue', dialog: false, input: null, enter: true },
  { prompt: 'restart continue', dialog: true, input: null, enter: false }
])(
  'a worker $prompt presses Enter only into its own composer (dialog=$dialog, input=$input)',
  async ({ prompt, dialog, input, enter }) => {
    const runtime = new OrcaRuntimeService()
    const writes: string[] = []
    let seq = 1
    runtime.setPtyController({
      write: (_ptyId: string, data: string) => {
        writes.push(data)
        if (data.startsWith('\x1b[200~')) {
          if (dialog) {
            queueMicrotask(() => runtime.onPtyData('pty-1', DIALOG, ++seq))
          }
          if (input !== null) {
            // After the write returns, so it lands after the paste was recorded.
            queueMicrotask(() => runtime.terminalRunFacts.recordInput('pty-1', 'driving', input))
          }
        }
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => 'codex',
      getSize: () => ({ cols: 100, rows: 30 })
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the protected registration a spawned worker terminal goes through; no public seam exists.
    const internals = runtime as unknown as {
      registerPty: (ptyId: string, worktreeId: string) => void
      issuePtyHandle: (pty: unknown) => void
      ptysById: Map<string, unknown>
      handles: Map<string, unknown>
    }
    internals.registerPty('pty-1', 'wt-1')
    runtime.onPtyData('pty-1', COMPOSER, seq)
    internals.issuePtyHandle(internals.ptysById.get('pty-1'))
    const [handle] = internals.handles.keys()
    try {
      const hold = dialog ? 'agent-interactive-prompt' : 'terminal-input'
      if (prompt === 'restart continue') {
        const sent = await sendRestartContinuePrompt(
          runtime,
          handle,
          'Continue.',
          'd-1:restart-continue'
        )
        expect(writes.includes('\r')).toBe(enter)
        expect(sent).toEqual(enter ? true : { withheldFor: hold })
        return
      }
      const sent = await runtime.sendTerminalAgentPrompt(
        handle,
        'Carry out the task. '.repeat(100),
        {
          inputKind: 'orchestration',
          acceptQueued: true,
          observationTimeoutMs: 0,
          requestId: 'req-1',
          withholdSubmitOnDialog: true
        }
      )
      expect(writes.includes('\r')).toBe(enter)
      expect(sent.prompt?.submit).toMatchObject(
        enter ? { enteredAt: expect.any(Number) } : { withheldFor: hold }
      )
    } finally {
      await runtime.onPtyExit('pty-1', 0)
    }
  }
)

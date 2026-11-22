import { expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'

const COMPOSER = '\x1b[?2004h\x1b[?1049h› Ask Codex to do anything\r\n'
// Codex's hooks review, opening over a brief that was already pasted.
const DIALOG =
  '\x1b[2J\x1b[HCodex found new hooks in this project.\r\n› 1. Trust and run them\r\n  2. Skip\r\nPress enter to continue\r\n\x1b[?25h'

it.each([
  { dialog: false, enter: true },
  { dialog: true, enter: false }
])(
  'a worker brief never presses Enter into a dialog (dialog=$dialog)',
  async ({ dialog, enter }) => {
    const runtime = new OrcaRuntimeService()
    const writes: string[] = []
    let seq = 1
    runtime.setPtyController({
      write: (_ptyId: string, data: string) => {
        writes.push(data)
        if (dialog && data.startsWith('\x1b[200~')) {
          queueMicrotask(() => runtime.onPtyData('pty-1', DIALOG, ++seq))
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
        enter ? { enteredAt: expect.any(Number) } : { withheldFor: 'agent-interactive-prompt' }
      )
    } finally {
      await runtime.onPtyExit('pty-1', 0)
    }
  }
)

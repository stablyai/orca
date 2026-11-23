import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'
import { resolveWindowsAgentEnterWaitMs } from '../../../../shared/agent-launch/startup/agent-prompt-injection'

const host = vi.hoisted((): { platform: NodeJS.Platform } => ({ platform: 'darwin' }))

vi.mock('./pty-write-host-platform', () => ({
  resolvePtyWriteHostPlatform: () => host.platform
}))

const COMPOSER = '\x1b[?2004h\x1b[?1049h› Ask Codex to do anything\r\n'
// Codex shows its cursor once it repaints the pasted draft, which lets the render gate settle.
const REPAINT = '\x1b[?25h'
const BRIEF = 'Carry out the task. '.repeat(100)

afterEach(() => {
  vi.useRealTimers()
})

/** Ms from a fresh Codex worker's brief paste to its first Enter, on a `platform` host. */
async function briefEnterWaitMs(platform: NodeJS.Platform): Promise<number> {
  host.platform = platform
  vi.useFakeTimers()
  const runtime = new OrcaRuntimeService()
  let pastedAt: number | null = null
  let enteredAt: number | null = null
  let seq = 1
  runtime.setPtyController({
    write: (_ptyId: string, data: string) => {
      if (data.startsWith('\x1b[200~')) {
        pastedAt = Date.now()
        queueMicrotask(() => runtime.onPtyData('pty-1', REPAINT, ++seq))
      } else if (data === '\r' && enteredAt === null) {
        enteredAt = Date.now()
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
    ptysById: Map<string, { launchAgent?: string }>
    handles: Map<string, unknown>
  }
  internals.registerPty('pty-1', 'wt-1')
  // A worker terminal Orca launched Codex in.
  internals.ptysById.get('pty-1')!.launchAgent = 'codex'
  runtime.onPtyData('pty-1', COMPOSER, seq)
  internals.issuePtyHandle(internals.ptysById.get('pty-1'))
  const [handle] = internals.handles.keys()
  void runtime
    .sendTerminalAgentPrompt(handle, BRIEF, {
      inputKind: 'orchestration',
      acceptQueued: true,
      observationTimeoutMs: 0,
      requestId: 'req-1',
      withholdSubmitOnDialog: true
    })
    .catch(() => undefined)
  for (let elapsed = 0; enteredAt === null && elapsed < 30_000; elapsed += 50) {
    await vi.advanceTimersByTimeAsync(50)
  }
  await runtime.onPtyExit('pty-1', 0)
  expect(pastedAt).not.toBeNull()
  expect(enteredAt).not.toBeNull()
  return enteredAt! - pastedAt!
}

it('waits out Windows Codex reading the initial brief before its first Enter, and only there', async () => {
  const darwin = await briefEnterWaitMs('darwin')
  expect(await briefEnterWaitMs('linux')).toBe(darwin)
  // The render gate settles 1.5 s after the repaint, well before 3 ms per key event.
  expect(darwin).toBeLessThan(3 * BRIEF.length)
  const windows = await briefEnterWaitMs('win32')
  expect(windows).toBeGreaterThanOrEqual(500 + 3 * BRIEF.length)
  expect(windows).toBeLessThanOrEqual(resolveWindowsAgentEnterWaitMs('win32', 'codex', BRIEF)! + 50)
})

/** Ms `terminal send --enter` holds Enter after `text` for an agent on a `platform` host. */
async function terminalSendEnterWaitMs(platform: NodeJS.Platform, text: string): Promise<number> {
  vi.useFakeTimers()
  let textAt = 0
  let enteredAt: number | null = null
  const writer = new RuntimeTerminalWriter(
    (_ptyId, data) => {
      if (data === '\r') {
        enteredAt = Date.now()
      } else {
        textAt = Date.now()
      }
      return true
    },
    () => platform,
    () => 'codex'
  )
  const sent = writer.writeAction('pty-1', { text, enter: true }, `${text}\r`, {
    inputKind: 'driving'
  })
  for (let elapsed = 0; enteredAt === null && elapsed < 60_000; elapsed += 50) {
    await vi.advanceTimersByTimeAsync(50)
  }
  await sent
  return enteredAt! - textAt
}

it('keeps terminal send timing, holding a long Windows Codex send at 20 s', async () => {
  const short = 'reply when done\nthanks'
  // 500 ms settle plus a few ms of ingest, as before, off Windows.
  expect(await terminalSendEnterWaitMs('darwin', short)).toBeLessThan(600)
  expect(await terminalSendEnterWaitMs('linux', short)).toBeLessThan(600)
  expect(await terminalSendEnterWaitMs('win32', short)).toBeGreaterThanOrEqual(
    500 + 3 * short.length
  )
  const long = 'x\n'.repeat(10_000)
  expect(await terminalSendEnterWaitMs('win32', long)).toBeLessThanOrEqual(20_050)
  expect(await terminalSendEnterWaitMs('win32', long)).toBeGreaterThanOrEqual(20_000)
})

it('applies the Windows Enter wait on Windows hosts only, within 20 s', () => {
  expect(resolveWindowsAgentEnterWaitMs('darwin', 'codex', 'x'.repeat(5000))).toBeNull()
  expect(resolveWindowsAgentEnterWaitMs('linux', 'codex', 'x'.repeat(5000))).toBeNull()
  expect(resolveWindowsAgentEnterWaitMs('win32', 'codex', 'x'.repeat(100_000))).toBe(20_000)
})

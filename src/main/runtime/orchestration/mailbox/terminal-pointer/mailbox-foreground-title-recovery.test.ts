import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createDatabase,
  createRuntime,
  createBoundRun,
  insertDirectRunMessage,
  PTY_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))
const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const OMP_COMPOSER = readFileSync(
  join(__dirname, '..', '..', '..', '__fixtures__', 'omp-18-composer.txt'),
  'utf8'
)

// OMP proves readiness only by title and its composer is unreadable, so mail never holds for it (like Windows).
it('mail for a title-only agent waits out a shell in front without a hold, then submits after fg', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  vi.useFakeTimers()
  const db = createDatabase('orca-mail-title-recovery-')
  const { runtime, write } = await createRuntime(db, { launchAgent: 'omp' })
  let shell = true
  runtime.setPtyController({
    write,
    kill: vi.fn(),
    getSize: () => ({ cols: 120, rows: 40 }),
    getForegroundProcess: async () => (shell ? 'zsh' : 'omp'),
    supportsForegroundObservation: () => true,
    inspectProcess: async () => ({
      foregroundProcess: shell ? 'zsh' : 'omp',
      hasChildProcesses: !shell,
      foregroundObservation: {
        ptyId: PTY_ID,
        ptyIncarnationId: 'mailbox-incarnation',
        authorityGeneration: 'synthetic-host',
        observationEpoch: 1,
        capturedAgeMs: 0,
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: shell ? 'shell' : 'non-shell',
        processName: shell ? 'zsh' : 'omp'
      }
    }),
    writeWithSettlement: (ptyId, text) => {
      write(ptyId, text)
      return { outcome: 'accepted' }
    }
  })
  try {
    await runtime.listTerminals()
    runtime.onPtyData(PTY_ID, `${OMP_COMPOSER}\x1b]0;π > capture-cwd\x07`, Date.now())
    const run = createBoundRun(db, 'Title-only recovery')
    insertDirectRunMessage(db, run.id, 'Held while the shell was in front')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).not.toHaveBeenCalled()
    expect(await runtime.readTerminalMailHold(`run:${run.id}`)).not.toMatchObject({
      kind: 'not-foreground'
    })

    shell = false
    await vi.advanceTimersByTimeAsync(1000)
    runtime.onPtyData(PTY_ID, `\x1b[2J\x1b[H${OMP_COMPOSER}\x1b]0;π > capture-cwd\x07`, Date.now())
    await vi.advanceTimersByTimeAsync(125000)
    expect(write.mock.calls.map(([, text]) => text)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
  } finally {
    db.close()
  }
})

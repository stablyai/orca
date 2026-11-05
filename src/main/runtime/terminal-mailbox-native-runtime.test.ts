import './rpc/unused-default-rpc-methods.test-fixture'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const TAB = '11111111-1111-4111-8111-111111111111'
const LEAF = '22222222-2222-4222-8222-222222222222'
const PANE = `${TAB}:${LEAF}`
const PTY = 'native-mailbox-pty'
const HANDLE = 'term_native_mailbox'
const TOKEN = 'native-mailbox-test-proof'
const databases: OrchestrationDb[] = []

class NativeMailboxRuntime extends OrcaRuntimeService {
  publishDsbForeground() {
    const pty = this.ptysById.get(PTY)
    if (pty) {
      pty.foregroundAgent = 'dsb'
    }
  }

  idleVerdict() {
    const pty = this.ptysById.get(PTY)
    return pty ? this.evaluateTuiIdleForPty(pty) : null
  }
}

function createFixture() {
  const runtime = new NativeMailboxRuntime(null)
  const db = new OrchestrationDb(':memory:')
  const write = vi.fn((_pty: string, _data: string) => true)
  runtime.setOrchestrationDb(db)
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: vi.fn(),
    getForegroundProcess: async () => null
  })
  runtime.registerPty(PTY, 'repo-native::/tmp/native-mailbox', null, {
    tabId: TAB,
    leafId: LEAF,
    incarnationId: 'native-process-1',
    agentLaunchAuthority: { launchToken: TOKEN, launchAgent: 'codex' }
  })
  runtime.registerPreAllocatedHandleForPty(PTY, HANDLE)
  const proof = { terminalHandle: HANDLE, paneKey: PANE, launchToken: TOKEN }
  let sequence = 0
  const status = async (title: string) => {
    runtime.onPtyData(PTY, `\x1b]0;${title}\x07`, ++sequence)
    await runtime.serializeMainTerminalBuffer(PTY)
  }
  const mail = () => {
    const message = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'test-sender',
      to: HANDLE,
      subject: 'native mailbox',
      body: 'PRIVATE_BODY_NOT_FOR_PTY',
      type: 'status'
    })
    runtime.notifyMessageArrived(HANDLE, 'status')
    return message
  }
  const fixture = { runtime, db, write, proof, status, mail }
  databases.push(db)
  return fixture
}

function textWritten(f: ReturnType<typeof createFixture>): string[] {
  return f.write.mock.calls.map((call) => String(call[1]))
}

describe('subscriptions on an execution host without a renderer graph', () => {
  afterEach(() => {
    vi.clearAllTimers()
    for (const db of databases.splice(0)) {
      db.close()
    }
    vi.useRealTimers()
  })

  it('registers a verified PTY-backed receiver and offers a pointer without consuming mail', async () => {
    vi.useFakeTimers()
    const f = createFixture()
    expect(f.runtime.terminalMailboxSubscription('subscribe', f.proof).subscribed).toBe(true)
    await f.status('Codex working')
    const message = f.mail()
    await vi.advanceTimersByTimeAsync(600)
    expect(f.write).not.toHaveBeenCalled()
    await f.status('Codex done')
    await vi.advanceTimersByTimeAsync(800)
    expect(f.runtime.idleVerdict()).toEqual({ kind: 'ready-strong' })
    expect(textWritten(f)).toEqual([expect.stringContaining(`inbox --terminal ${HANDLE}`), '\r'])
    expect(textWritten(f).join('')).not.toContain('PRIVATE_BODY_NOT_FOR_PTY')
    expect(f.db.getMessageById(message.id)?.read).toBe(0)
  })

  it('offers a pointer without auto-submitting a non-TUI foreground agent', async () => {
    vi.useFakeTimers()
    const f = createFixture()
    f.runtime.terminalMailboxSubscription('subscribe', f.proof)
    await f.status('Codex done')
    f.runtime.publishDsbForeground()
    const message = f.mail()
    await vi.advanceTimersByTimeAsync(800)
    expect(textWritten(f)).toEqual([expect.stringContaining(`inbox --terminal ${HANDLE}`)])
    expect(f.runtime.terminalMailboxSubscription('status', f.proof).reason).toBe(
      'manual_submit_required'
    )
    expect(f.db.getMessageById(message.id)?.read).toBe(0)
  })

  it('does not wake a native terminal without explicit receiver subscription', async () => {
    vi.useFakeTimers()
    const f = createFixture()
    await f.status('Codex done')
    const message = f.mail()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.write).not.toHaveBeenCalled()
    expect(f.db.getMessageById(message.id)?.read).toBe(0)
  })

  it('refuses a forged launch proof even when the native PTY exists', () => {
    const f = createFixture()
    expect(() =>
      f.runtime.terminalMailboxSubscription('subscribe', { ...f.proof, launchToken: 'wrong' })
    ).toThrow('verified current terminal launch')
    expect(f.write).not.toHaveBeenCalled()
  })

  it('does not submit Enter after the native process becomes working', async () => {
    vi.useFakeTimers()
    const f = createFixture()
    f.runtime.terminalMailboxSubscription('subscribe', f.proof)
    await f.status('Codex done')
    f.mail()
    await vi.advanceTimersByTimeAsync(50)
    expect(textWritten(f)).toEqual([expect.stringContaining('orchestration inbox')])
    await f.status('Codex working')
    await vi.advanceTimersByTimeAsync(800)
    expect(textWritten(f)).toHaveLength(1)
    await f.status('Codex done')
    await vi.advanceTimersByTimeAsync(800)
    expect(textWritten(f)).toHaveLength(1)
  })

  it('does not submit Enter after the native pane acquires a Run owner', async () => {
    vi.useFakeTimers()
    const f = createFixture()
    f.runtime.terminalMailboxSubscription('subscribe', f.proof)
    await f.status('Codex done')
    f.mail()
    await vi.advanceTimersByTimeAsync(50)
    expect(textWritten(f)).toHaveLength(1)
    f.db.createRun({ objective: 'new owner', coordinatorHandle: HANDLE, coordinatorPaneKey: PANE })
    await vi.advanceTimersByTimeAsync(800)
    expect(textWritten(f)).toHaveLength(1)
  })
})

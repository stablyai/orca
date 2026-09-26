import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyIncarnationId } from '../../../shared/pty-incarnation'
import type { IPtyProvider } from '../../providers/types'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { installSessionSshOutputIntake } from './delivery/ssh-intake'
import { wirePtyIpcSession } from './delivery/wire-session'
import { bindProviderListeners } from './provider/bind-listeners'
import { unbindLocalProviderListeners } from './provider/listener-lifecycle'
import { getLocalPtyProvider, setLocalPtyProvider } from './provider/registry'
import { createPtyIpcSession } from './session'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const PTY_ID = 'pty-kept'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

/** Stands in for the follow-up that writes the record while deciding the exit inside onPtyExit. */
class KeepingRuntime extends OrcaRuntimeService {
  override onPtyExit(
    ptyId: string,
    exitCode: number,
    exitIncarnationId?: PtyIncarnationId,
    options?: Parameters<OrcaRuntimeService['onPtyExit']>[3]
  ): void {
    super.onPtyExit(ptyId, exitCode, exitIncarnationId, options)
    this.terminalExitRecords.record({
      worktreeId: 'wt-1',
      leafId: LEAF_ID,
      ptyId,
      incarnationId: exitIncarnationId ?? null,
      exitCode,
      cause: { kind: 'exited', exitCode },
      exitedAt: 1
    })
  }
}

function makeWindowSession() {
  const channels: string[] = []
  const windowStub = {
    isDestroyed: () => false,
    webContents: { send: (channel: string) => channels.push(channel) }
  }
  const runtime = new KeepingRuntime()
  // Why the same window: main's notifier and the PTY session send on one webContents, whose
  // messages the renderer receives in send order.
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn(),
    terminalExitRecordsChanged: () => windowStub.webContents.send('terminalExitRecords:changed')
  })
  const session = createPtyIpcSession({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exit delivery reads only isDestroyed and webContents.send from the window.
    mainWindow: windowStub as unknown as BrowserWindow,
    runtime
  })
  wirePtyIpcSession(session)
  return { channels, session }
}

const priorProvider = getLocalPtyProvider()
afterEach(() => {
  unbindLocalProviderListeners()
  setLocalPtyProvider(priorProvider)
})

describe('a kept exit reaches the desktop before its pty:exit', () => {
  it('on the local daemon path', () => {
    const { channels, session } = makeWindowSession()
    let emitExit: (payload: { id: string; code: number; incarnationId?: string }) => void = () => {}
    const provider = {
      onData: () => () => {},
      onExit: (callback: typeof emitExit) => {
        emitExit = callback
        return () => {}
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listener binding subscribes only to onData and onExit, and treats the optional hooks as absent.
    setLocalPtyProvider(provider as unknown as IPtyProvider)
    bindProviderListeners(session)

    emitExit({ id: PTY_ID, code: 3 })

    expect(channels.filter((channel) => channel !== 'pty:data')).toEqual([
      'terminalExitRecords:changed',
      'pty:exit'
    ])
  })

  it('on the SSH relay path', async () => {
    const { channels, session } = makeWindowSession()
    installSessionSshOutputIntake(session)

    await session.sshOutputIntake!.acceptExit({
      id: PTY_ID,
      code: 3,
      providerGeneration: 1,
      ptyIncarnation: 'inc-1'
    })

    expect(channels).toEqual(['terminalExitRecords:changed', 'pty:exit'])
  })
})

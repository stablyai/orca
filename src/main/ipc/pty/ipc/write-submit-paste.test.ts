import type { IpcMainEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalRunFactsRegister } from '../../../runtime/terminal-run-facts'
import { ptyOwnership } from '../provider/ownership-state'
import { installPtyWriteIpcHandlers } from './write'

const handlers = vi.hoisted(() => new Map<string, (event: IpcMainEvent, arg: unknown) => void>())
vi.mock('../../pty-host-bindings', () => ({
  getPtyIpc: () => ({
    on: (name: string, listener: (event: IpcMainEvent, arg: unknown) => void) =>
      handlers.set(name, listener),
    handle: vi.fn(),
    removeAllListeners: (name: string) => handlers.delete(name)
  })
}))
vi.mock('../provider/registry', () => ({ tryGetProviderForPty: vi.fn() }))

const PTY_ID = 'invented-paste-pty'
afterEach(() => {
  handlers.clear()
  ptyOwnership.delete(PTY_ID)
})

function event(sender: object): IpcMainEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this handler reads only the sender identity from the event.
  return { sender } as never
}

describe('trusted renderer paste-interruption IPC', () => {
  it('resets only the local PTY, preserving normal paste suppression until a trusted reset', () => {
    const facts = new TerminalRunFactsRegister()
    facts.setSubmissionTracking(true)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    const runtime = { terminalRunFacts: facts }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration and this reset handler use only these window/facts members.
    installPtyWriteIpcHandlers({ mainWindow: mainWindow as never, runtime: runtime as never })
    const interrupt = handlers.get('pty:interruptSubmissionPaste')
    if (!interrupt) {
      throw new Error('paste-interruption handler missing')
    }
    ptyOwnership.set(PTY_ID, 'local')
    facts.recordInput(PTY_ID, 'driving', '\x1b[200~invented\rbody', undefined, 'human')
    interrupt(event({}), PTY_ID)
    facts.recordInput(PTY_ID, 'driving', '\r', undefined, 'human')
    expect(facts.takeSubmitAuthor(PTY_ID)).toBeUndefined()
    ptyOwnership.set(PTY_ID, 'ssh:invented')
    interrupt(event(mainWindow.webContents), PTY_ID)
    facts.recordInput(PTY_ID, 'driving', '\r', undefined, 'human')
    expect(facts.takeSubmitAuthor(PTY_ID)).toBeUndefined()
    ptyOwnership.set(PTY_ID, 'local')
    interrupt(event(mainWindow.webContents), PTY_ID)
    facts.recordInput(PTY_ID, 'driving', '\r', undefined, 'human')
    expect(facts.takeSubmitAuthor(PTY_ID)).toBe('human')
  })
})

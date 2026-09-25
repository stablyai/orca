import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listRegisteredPtys, registerPty, unregisterPty } from '../../../memory/pty-registry'
import { agentSessionPtyWriteGate } from '../../../runtime/agent-session-pty-write-gate'
import { ptyOwnership } from '../provider/ownership-state'
import { createPtyWriteInput } from './write-input'

const PTY_ID = 'pty-write-input-stamp'

const { provider } = vi.hoisted(() => ({ provider: { write: vi.fn() } }))

vi.mock('../provider/registry', () => ({
  tryGetProviderForPty: (id: string) => (id === PTY_ID ? provider : undefined)
}))

const mainWindow = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: vi.fn() }
}

function writePtyInput(data: string) {
  return createPtyWriteInput({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture is only read through isDestroyed(), webContents.isDestroyed() and webContents.send, all three of which it provides; Electron's BrowserWindow cannot be constructed outside a running app.
    mainWindow: mainWindow as never,
    clearHiddenRendererResizeOutput: vi.fn()
  }).writePtyInput({ id: PTY_ID, data })
}

function stamp() {
  return listRegisteredPtys().find((pty) => pty.ptyId === PTY_ID)?.lastInputAtMs
}

beforeEach(() => {
  ptyOwnership.set(PTY_ID, null)
  provider.write.mockReset()
  registerPty({ ptyId: PTY_ID, worktreeId: null, sessionId: null, paneKey: 'tab:leaf', pid: 1 })
})

afterEach(() => {
  ptyOwnership.delete(PTY_ID)
  unregisterPty(PTY_ID)
  vi.restoreAllMocks()
})

describe('writePtyInput registry stamp', () => {
  it('records the keystroke so the session binder can break a same-directory tie', () => {
    const before = Date.now()

    expect(writePtyInput('hello')).toBe(true)

    const stamped = stamp()
    expect(stamped).toBeTypeOf('number')
    expect(stamped).toBeGreaterThanOrEqual(before)
  })

  it('does not stamp for an automatic terminal query reply', () => {
    // xterm answers CPR/DA1 queries on its own; a reply must never age a pane
    // into winning a same-directory session tie.
    expect(writePtyInput('\x1b[3;1R')).toBe(true)

    expect(stamp()).toBeUndefined()
    expect(provider.write).toHaveBeenCalled()
  })

  it('leaves the pty unstamped when the write is refused', () => {
    vi.spyOn(agentSessionPtyWriteGate, 'admit').mockReturnValue({
      admitted: false,
      refusal: {
        code: 'agent_session_checkpoint_stale',
        sessionId: 'session-1',
        ownerRuntimeKind: null,
        handoffStage: null,
        ownerPid: null,
        runtimeFence: null
      }
    })

    expect(writePtyInput('hello')).toBe(false)
    expect(stamp()).toBeUndefined()
    expect(provider.write).not.toHaveBeenCalled()
  })
})

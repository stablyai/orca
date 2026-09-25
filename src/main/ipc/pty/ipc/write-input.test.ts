import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listRegisteredPtys, registerPty, unregisterPty } from '../../../memory/pty-registry'
import { ptyOwnership } from '../provider/ownership-state'
import { createPtyWriteInput } from './write-input'

const PTY_ID = 'pty-write-input-stamp'
/** Registered like any other pane, but the mocked provider below serves only PTY_ID. */
const UNBACKED_PTY_ID = 'pty-write-input-unbacked'

const { provider } = vi.hoisted(() => ({ provider: { write: vi.fn() } }))

vi.mock('../provider/registry', () => ({
  tryGetProviderForPty: (id: string) => (id === PTY_ID ? provider : undefined)
}))

const mainWindow = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: vi.fn() }
}

function writePtyInput(data: string, ptyId: string = PTY_ID) {
  return createPtyWriteInput({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture is only read through isDestroyed(), webContents.isDestroyed() and webContents.send, all three of which it provides; Electron's BrowserWindow cannot be constructed outside a running app.
    mainWindow: mainWindow as never
  }).writePtyInput({ id: ptyId, data })
}

/** Prompt activity the OpenCode session binder reads; absent until one arrives. */
function promptActivityAt(ptyId: string): number | undefined {
  return listRegisteredPtys().find((pty) => pty.ptyId === ptyId)?.lastInputAtMs
}

function register(ptyId: string): void {
  registerPty({ ptyId, worktreeId: null, sessionId: null, paneKey: 'tab:leaf', pid: 1 })
}

beforeEach(() => {
  ptyOwnership.set(PTY_ID, null)
  ptyOwnership.set(UNBACKED_PTY_ID, null)
  provider.write.mockReset()
  register(PTY_ID)
  register(UNBACKED_PTY_ID)
})

afterEach(() => {
  ptyOwnership.delete(PTY_ID)
  ptyOwnership.delete(UNBACKED_PTY_ID)
  unregisterPty(PTY_ID)
  unregisterPty(UNBACKED_PTY_ID)
  vi.restoreAllMocks()
})

describe('writePtyInput registry stamp', () => {
  it('records the keystroke so the session binder can break a same-directory tie', () => {
    const before = Date.now()

    expect(writePtyInput('hello')).toBe(true)

    const stamped = promptActivityAt(PTY_ID)
    expect(stamped).toBeTypeOf('number')
    expect(stamped).toBeGreaterThanOrEqual(before)
  })

  it('does not stamp for an automatic terminal query reply', () => {
    // xterm answers CPR/DA1 queries on its own; a reply must never age a pane
    // into winning a same-directory session tie.
    expect(writePtyInput('\x1b[3;1R')).toBe(true)

    expect(promptActivityAt(PTY_ID)).toBeUndefined()
    expect(provider.write).toHaveBeenCalled()
  })

  it('leaves the pty unstamped when no provider can serve the write', () => {
    // Reaches the provider lookup and gets nothing back, so no bytes are
    // dispatched — the pane must not be credited with activity it never had.
    expect(writePtyInput('hello', UNBACKED_PTY_ID)).toBe(false)

    expect(promptActivityAt(UNBACKED_PTY_ID)).toBeUndefined()
    expect(provider.write).not.toHaveBeenCalled()
  })
})

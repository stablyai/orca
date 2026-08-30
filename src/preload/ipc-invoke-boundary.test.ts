import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke: rawInvoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('electron', () => ({ ipcRenderer: { invoke: rawInvoke } }))

import { invoke, readableInvokeRejection } from './ipc-invoke-boundary'

/** The message the renderer would read after the boundary handled this rejection. */
async function rejectionMessage(thrown: unknown): Promise<string> {
  rawInvoke.mockRejectedValueOnce(thrown)
  try {
    await invoke('workspaces:delete')
    throw new Error('expected the boundary to reject')
  } catch (error) {
    return (error as Error).message
  }
}

describe('preload IPC invoke boundary', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    rawInvoke.mockReset()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('resolves untouched, so wrapping costs the success path nothing', async () => {
    rawInvoke.mockResolvedValueOnce({ ok: true })

    await expect(invoke('workspaces:delete', 'w1')).resolves.toEqual({ ok: true })
    expect(rawInvoke).toHaveBeenCalledWith('workspaces:delete', 'w1')
  })

  describe('the shapes an envelope arrives in', () => {
    it('strips the renderer wrapper Electron rejects invoke with', async () => {
      const message = await rejectionMessage(
        new Error(
          "Error invoking remote method 'workspaces:delete': Error: Worktree has uncommitted changes"
        )
      )

      expect(message).toBe('Worktree has uncommitted changes')
    })

    it("strips main's handler wrapper", async () => {
      const message = await rejectionMessage(
        new Error(
          "Error occurred in handler for 'workspaces:delete': Error: Worktree has uncommitted changes"
        )
      )

      expect(message).toBe('Worktree has uncommitted changes')
    })

    /** A relay hop re-throws an already-wrapped message inside its own, so the envelope nests. */
    it('strips a relay re-throw that wrapped an already-wrapped message', async () => {
      const message = await rejectionMessage(
        new Error(
          "Error invoking remote method 'pty:connect': Error occurred in handler for 'pty:connect': Error: SSH connection lost, reconnecting"
        )
      )

      expect(message).toBe('SSH connection lost, reconnecting')
    })
  })

  describe('an envelope with nothing behind it', () => {
    /**
     * The tail is `error.toString()`, so a message-less rejection arrives as a bare class name.
     * Narrowing that to '' would render an empty toast — strictly worse than the plumbing — so the
     * boundary leaves it for the call site, which has copy naming what it was doing.
     */
    it('leaves an empty tail alone rather than rejecting with an empty message', async () => {
      const wrapped = "Error invoking remote method 'workspaces:delete': "

      expect(await rejectionMessage(new Error(wrapped))).toBe(wrapped)
    })

    it('leaves an absent tail alone', async () => {
      const wrapped = "Error invoking remote method 'workspaces:delete'"

      expect(await rejectionMessage(new Error(wrapped))).toBe(wrapped)
    })

    it('leaves a bare class-name tail alone', async () => {
      const wrapped = "Error invoking remote method 'workspaces:delete': Error"

      expect(await rejectionMessage(new Error(wrapped))).toBe(wrapped)
    })
  })

  describe('what the boundary must not destroy', () => {
    it('keeps the wrapped form and the stack for diagnostics', async () => {
      const thrown = new Error(
        "Error invoking remote method 'workspaces:delete': Error: Worktree has uncommitted changes"
      )
      const stack = thrown.stack

      rawInvoke.mockRejectedValueOnce(thrown)
      await expect(invoke('workspaces:delete')).rejects.toThrow('Worktree has uncommitted changes')

      expect(warn).toHaveBeenCalledWith(
        "[ipc] 'workspaces:delete' rejected; raw:",
        "Error invoking remote method 'workspaces:delete': Error: Worktree has uncommitted changes",
        stack
      )
      // V8 fixes `stack` at construction, so the wrapped form survives on the error itself.
      expect(thrown.stack).toContain("Error invoking remote method 'workspaces:delete'")
    })

    it('rejects with the same error object, so identity and properties survive', async () => {
      const thrown = Object.assign(
        new TypeError("Error invoking remote method 'git:push': Error: refusing to push"),
        { code: 'EPUSH' }
      )

      rawInvoke.mockRejectedValueOnce(thrown)
      const caught = await invoke('git:push').catch((error: unknown) => error)

      expect(caught).toBe(thrown)
      expect(caught).toBeInstanceOf(TypeError)
      expect((caught as { code: string }).code).toBe('EPUSH')
    })

    it('passes a non-Error rejection through untouched', () => {
      expect(readableInvokeRejection('plain string', 'git:push')).toBe('plain string')
      expect(readableInvokeRejection(undefined, 'git:push')).toBeUndefined()
    })

    /** A message that never crossed IPC must not be logged as though it had. */
    it('leaves an unwrapped message alone and stays silent', async () => {
      expect(await rejectionMessage(new Error('Worktree has uncommitted changes'))).toBe(
        'Worktree has uncommitted changes'
      )
      expect(warn).not.toHaveBeenCalled()
    })
  })
})

import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { withFileChooserBlocked } from './guest-file-chooser'
import { coverFrameSessionWithFileChooserInterception } from './file-chooser-frame-coverage'

// Chromium can report the chooser an input opened after the input's own reply, but always before
// the reply to the next command on the session.
function guestReportingChooserLate(): WebContents {
  const dbg = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    sendCommand: async (method: string, params?: { enabled?: boolean }) => {
      if (method === 'Page.setInterceptFileChooserDialog' && params?.enabled === false) {
        dbg.emit('message', {}, 'Page.fileChooserOpened', {
          backendNodeId: 7,
          mode: 'selectSingle'
        })
      }
      return {}
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chooser reads only these members.
  return {
    id: 1,
    debugger: dbg,
    isDestroyed: () => false,
    isCrashed: () => false,
    setIgnoreMenuShortcuts: () => {}
  } as unknown as WebContents
}

// A cross-site frame reports its chooser only on its own session, and only if that session intercepts.
function guestWithFrameChooser(frameSessionId: string): WebContents {
  const intercepting = new Set<string | undefined>()
  const dbg = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    sendCommand: async (method: string, params?: { enabled?: boolean }, sessionId?: string) => {
      if (method === 'Page.setInterceptFileChooserDialog') {
        if (params?.enabled) {
          intercepting.add(sessionId)
        } else {
          intercepting.delete(sessionId)
        }
      }
      if (method === 'Input.dispatchMouseEvent' && intercepting.has(frameSessionId)) {
        dbg.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 9 }, frameSessionId)
      }
      return {}
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chooser reads only these members.
  return {
    id: 2,
    debugger: dbg,
    isDestroyed: () => false,
    isCrashed: () => false,
    setIgnoreMenuShortcuts: () => {}
  } as unknown as WebContents
}

describe('withFileChooserBlocked', () => {
  it('catches the chooser of a frame that input reached after interception began', async () => {
    const guest = guestWithFrameChooser('frame-session')
    await expect(
      withFileChooserBlocked(
        guest,
        async () => {
          await coverFrameSessionWithFileChooserInterception(guest, 'frame-session')
          await guest.debugger.sendCommand('Input.dispatchMouseEvent', {}, 'frame-session')
        },
        { agent: false }
      )
    ).rejects.toMatchObject({ code: 'browser_file_chooser_opened' })
  })

  it('refuses an input whose chooser is reported after the input replied', async () => {
    await expect(
      withFileChooserBlocked(guestReportingChooserLate(), async () => 'clicked', { agent: false })
    ).rejects.toMatchObject({ code: 'browser_file_chooser_opened' })
  })
})

import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { withFileChooserBlocked } from './guest-file-chooser'

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

describe('withFileChooserBlocked', () => {
  it('refuses an input whose chooser is reported after the input replied', async () => {
    await expect(
      withFileChooserBlocked(guestReportingChooserLate(), async () => 'clicked', { agent: false })
    ).rejects.toMatchObject({ code: 'browser_file_chooser_opened' })
  })
})

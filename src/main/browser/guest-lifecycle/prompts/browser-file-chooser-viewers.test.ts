import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import type { BrowserFileChooserRequest } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import {
  addBrowserFileChooserViewer,
  answerBrowserFileChooser,
  askBrowserFileChooserViewer,
  browserFileChooserViewer
} from './browser-file-chooser-viewers'

function fakeGuest(): { guest: WebContents; sent: [string, unknown][] } {
  const sent: [string, unknown][] = []
  const dbg = {
    isAttached: () => true,
    sendCommand: async (method: string, params: unknown) => {
      sent.push([method, params])
      return {}
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the answer path reads only these members.
  const guest = Object.assign(new EventEmitter(), {
    id: 41,
    debugger: dbg,
    isDestroyed: () => false,
    isCrashed: () => false,
    setIgnoreMenuShortcuts: () => {}
  }) as unknown as WebContents
  return { guest, sent }
}

describe('streamed file chooser answers', () => {
  it('sets files only from the device whose input opened the picker', async () => {
    const { guest, sent } = fakeGuest()
    const asked: BrowserFileChooserRequest[] = []
    const remove = addBrowserFileChooserViewer(guest.id, {
      pairedDeviceId: 'device-a',
      ask: (request) => asked.push(request)
    })
    const viewer = browserFileChooserViewer(guest.id, 'device-a')
    expect(browserFileChooserViewer(guest.id, 'device-b')).toBeNull()
    askBrowserFileChooserViewer(guest, viewer!, {
      backendNodeId: 9,
      sessionId: undefined,
      multiple: true
    })
    const file = join(mkdtempSync(join(tmpdir(), 'file-chooser-')), 'a.txt')
    writeFileSync(file, 'a')
    const answer = { requestId: asked[0].requestId, files: [file] }

    expect(await answerBrowserFileChooser('device-b', answer)).toBe('rejected')
    expect(await answerBrowserFileChooser(undefined, answer)).toBe('rejected')
    expect(sent).toEqual([])
    expect(await answerBrowserFileChooser('device-a', answer)).toBe('answered')
    expect(sent).toEqual([['DOM.setFileInputFiles', { files: [file], backendNodeId: 9 }]])
    expect(await answerBrowserFileChooser('device-a', answer)).toBe('rejected')
    remove()
  })
})

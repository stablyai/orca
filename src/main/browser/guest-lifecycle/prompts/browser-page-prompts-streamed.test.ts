import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

import { addBrowserPagePromptViewer } from './browser-page-prompt-viewers'
import { openBrowserPagePrompt, respondToStreamedBrowserPagePrompt } from './browser-page-prompts'

function mockGuest(id: number): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prompts only read id, isDestroyed and the navigation and destroyed events.
  const guest = new EventEmitter() as unknown as Electron.WebContents
  Object.assign(guest, { id, isDestroyed: () => false })
  return guest
}

it('lets only a device streaming the asking page answer its prompt', async () => {
  const page = mockGuest(301)
  const otherPage = mockGuest(302)
  const show = vi.fn()
  const close = vi.fn()
  addBrowserPagePromptViewer(page.id, { pairedDeviceId: 'laptop', show, close })
  addBrowserPagePromptViewer(otherPage.id, { pairedDeviceId: 'intruder', show() {}, close() {} })
  const settle = vi.fn()
  const opening = openBrowserPagePrompt({
    kind: 'site-permission',
    requester: page,
    target: 'stream-viewers',
    details: () => ({ origin: 'https://meet.example', permissions: ['camera'] }),
    parseAnswer: (value) => (value === 'allow' || value === 'block' ? value : undefined),
    settle
  })
  expect(opening).toBe('prompting')
  const { requestId } = show.mock.calls[0][0]
  const answer = { requestId, answer: 'allow' }

  // A device streaming another page, or no paired device, can't answer it.
  expect(await respondToStreamedBrowserPagePrompt('intruder', answer)).toBe('rejected')
  expect(await respondToStreamedBrowserPagePrompt(undefined, answer)).toBe('rejected')
  expect(settle).not.toHaveBeenCalled()

  expect(await respondToStreamedBrowserPagePrompt('laptop', answer)).toBe('answered')
  expect(settle).toHaveBeenCalledWith('allow')
  expect(close).toHaveBeenCalledWith(requestId)
  expect(await respondToStreamedBrowserPagePrompt('laptop', answer)).toBe('rejected')
})

import { expect, it } from 'vitest'
import type { MobileFilePreviewHref } from '../../files/preview/mobile-file-preview-route'
import { openBotItemFile } from './bot-item-file-open'

function open(path: string): { pushed: MobileFilePreviewHref[]; toasts: string[] } {
  const pushed: MobileFilePreviewHref[] = []
  const toasts: string[] = []
  openBotItemFile({
    path,
    router: { push: (href) => pushed.push(href) },
    hostId: 'host-1',
    worktreeId: 'bot-home',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the opener only calls t(key, fallback, vars).
    t: ((_key: string, fallback: string) => fallback) as never,
    toast: (message) => toasts.push(message),
    onRequestClose: () => {}
  })
  return { pushed, toasts }
}

it('opens notes.md at its line for an item link to notes.md:12', () => {
  const { pushed, toasts } = open('notes.md:12')
  expect(toasts).toEqual([])
  expect(pushed.map((href) => href.params)).toEqual([
    expect.objectContaining({ relativePath: 'notes.md', name: 'notes.md', line: '12' })
  ])
})

// An image the phone can't draw (its host away, or a read refused) is named as the desktop names it,
// never by the host's path: on a shared agent that path is another person's folders.
import { expect, it } from 'vitest'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { mobileNativeChatImageLabel } from './mobile-native-chat-image-label'

const t: Translate = (_key, fallback) => fallback

it('names an undrawable image by its alt text or file, never by the host path', () => {
  for (const path of [
    '/Users/owner/Library/Application Support/orca/agent-session-attachments/a9e4bdb3-b5af-4d0c-86d7-01c934d80ffe/e2e-attachment.png',
    'C:\\Users\\owner\\AppData\\Roaming\\orca\\agent-session-attachments\\a9e4bdb3-b5af-4d0c-86d7-01c934d80ffe\\e2e-attachment.png'
  ]) {
    const label = mobileNativeChatImageLabel({ type: 'image-ref', path }, t)
    expect(label).toBe('e2e-attachment.png')
  }
  expect(mobileNativeChatImageLabel({ type: 'image-ref', path: '/a/b.png', alt: 'Chart' }, t)).toBe(
    'Chart'
  )
})

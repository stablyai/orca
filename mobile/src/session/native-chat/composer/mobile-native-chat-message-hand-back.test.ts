import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import { returnMobileNativeChatMessageToComposer } from './mobile-native-chat-message-hand-back'
import {
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './mobile-native-chat-draft-inputs'
import {
  resetMobileNativeChatDraftStoreForTests,
  setMobileNativeChatDraftText,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'

let renderer: ReactTestRenderer | null = null
let text = ''

afterEach(() => {
  act(() => renderer?.unmount())
  resetMobileNativeChatDraftStoreForTests()
  renderer = null
})

function Harness(): null {
  text = useMobileNativeChatDraft('scope')
  return null
}

it('appends a rewound message after the typed draft, its images after the attached ones, once', () => {
  act(() => {
    renderer = create(createElement(Harness))
  })
  act(() => {
    setMobileNativeChatDraftText('scope', 'typed first')
    updateMobileNativeChatDraftInputs('scope', (inputs) => ({
      ...inputs,
      images: [{ id: 'held', path: '/host/held.png', previewUri: 'file:///held.png' }]
    }))
  })
  const blocks = [
    { type: 'text' as const, text: 'look at [Image #1]' },
    { type: 'image-ref' as const, path: '/host/shot.png' }
  ]

  act(() => returnMobileNativeChatMessageToComposer('scope', 'rewound-user', blocks))
  act(() => returnMobileNativeChatMessageToComposer('scope', 'rewound-user', blocks))

  expect(text).toBe('typed first\n\nlook at [Image #2]')
  expect(readMobileNativeChatDraftInputs('scope').images).toEqual([
    { id: 'held', path: '/host/held.png', previewUri: 'file:///held.png' },
    { id: 'rewound-user-1', path: '/host/shot.png', previewUri: '/host/shot.png' }
  ])
})

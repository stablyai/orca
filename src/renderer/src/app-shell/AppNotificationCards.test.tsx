// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppNotificationCards } from './AppNotificationCards'

vi.mock('../components/feature-tips/ChatUiHereCornerCard', () => ({
  ChatUiHereCornerCard: () => {
    throw new Error('corner card failed')
  }
}))
vi.mock('../components/UpdateCard', () => ({ UpdateCard: () => null }))
vi.mock('../components/UnexpectedSignoutCard', () => ({ UnexpectedSignoutCard: () => null }))
vi.mock('../components/StarNagCard', () => ({ StarNagCard: () => null }))
vi.mock('../components/CodexSharedSettingsNoticeCard', () => ({
  CodexSharedSettingsNoticeCard: () => null
}))
vi.mock('@/diagnostics/crash-reporting/react-error-boundary-reporting', () => ({
  reportReactErrorBoundaryCrash: vi.fn()
}))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it('closes the chat UI corner card when it crashes so later prompts are not held', async () => {
  const onClose = vi.fn()
  await act(async () => {
    root.render(
      <AppNotificationCards
        activeView="terminal"
        shouldMountUpdateCard={false}
        chatUiHereCornerCardOpen
        onChatUiHereCornerCardClose={onClose}
      />
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(onClose).toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

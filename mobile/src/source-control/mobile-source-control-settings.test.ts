import { act } from 'react-test-renderer'
import { focusManager } from '@tanstack/react-query'
import { afterEach, expect, it } from 'vitest'
import { rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { hookMount, settleQueryNotifications } from '../test-support/rpc-recording/hook-mount'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { useMobileSourceControlSettings } from './mobile-source-control-settings'

let screen: ReturnType<typeof hookMount> | null = null

afterEach(async () => {
  await screen?.unmount()
  screen = null
  focusManager.setFocused(undefined)
})

// Starts away from desktop's defaults so the first read shows it landed.
function mountSettingsReader() {
  let diffShowWhitespace = true
  const seen: { diffShowWhitespace?: boolean } = {}
  const client = stubRpcClient({
    sendRequest: async () => rpcSuccess('1', { settings: { diffShowWhitespace } })
  })
  screen = hookMount(() => {
    seen.diffShowWhitespace = useMobileSourceControlSettings(
      'host-1',
      client,
      'connected'
    ).settings.diffShowWhitespace
  })
  return {
    screen,
    seen,
    hideWhitespaceOnDesktop: () => {
      diffShowWhitespace = false
    }
  }
}

it('shows a setting changed on the desktop when a screen opens again', async () => {
  const reader = mountSettingsReader()
  reader.screen.mount()
  await settleQueryNotifications()
  expect(reader.seen.diffShowWhitespace).toBe(true)
  reader.screen.leave()

  reader.hideWhitespaceOnDesktop()
  reader.screen.mount()
  await settleQueryNotifications()
  expect(reader.seen.diffShowWhitespace).toBe(false)
})

it('shows a setting changed on the desktop when the app comes back to the foreground', async () => {
  const reader = mountSettingsReader()
  reader.screen.mount()
  await settleQueryNotifications()
  expect(reader.seen.diffShowWhitespace).toBe(true)

  reader.hideWhitespaceOnDesktop()
  act(() => focusManager.setFocused(false))
  act(() => focusManager.setFocused(true))
  await settleQueryNotifications()
  expect(reader.seen.diffShowWhitespace).toBe(false)
})

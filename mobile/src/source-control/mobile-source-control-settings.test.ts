import { createElement } from 'react'
import { focusManager, QueryClientProvider } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import { createOrcaQueryClient } from '../query/orca-query-client'
import { settleQueryNotifications } from '../test-support/rpc-recording/hook-mount'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { useMobileSourceControlSettings } from './mobile-source-control-settings'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  focusManager.setFocused(undefined)
})

function desktopWithWhitespaceSetting() {
  let diffShowWhitespace = false
  const client = stubRpcClient({
    sendRequest: async () => ({
      id: '1',
      ok: true,
      result: { settings: { diffShowWhitespace } },
      _meta: { runtimeId: 'r' }
    })
  })
  return {
    client,
    showWhitespace: () => {
      diffShowWhitespace = true
    }
  }
}

function settingsScreen(client: ReturnType<typeof stubRpcClient>) {
  const queryClient = createOrcaQueryClient()
  const seen: { diffShowWhitespace?: boolean } = {}
  function Screen(): null {
    seen.diffShowWhitespace = useMobileSourceControlSettings(
      'host-1',
      client,
      'connected'
    ).settings.diffShowWhitespace
    return null
  }
  return {
    seen,
    async mount() {
      await act(async () => {
        renderer = create(
          createElement(QueryClientProvider, { client: queryClient }, createElement(Screen))
        )
      })
      await settleQueryNotifications()
    },
    async unmount() {
      await act(async () => renderer?.unmount())
      renderer = null
    }
  }
}

it('shows a setting changed on the desktop when a screen opens again', async () => {
  const desktop = desktopWithWhitespaceSetting()
  const screen = settingsScreen(desktop.client)
  await screen.mount()
  expect(screen.seen.diffShowWhitespace).toBe(false)
  await screen.unmount()

  desktop.showWhitespace()
  await screen.mount()
  expect(screen.seen.diffShowWhitespace).toBe(true)
})

it('shows a setting changed on the desktop when the app comes back to the foreground', async () => {
  const desktop = desktopWithWhitespaceSetting()
  const screen = settingsScreen(desktop.client)
  await screen.mount()
  expect(screen.seen.diffShowWhitespace).toBe(false)

  desktop.showWhitespace()
  await act(async () => focusManager.setFocused(false))
  await act(async () => focusManager.setFocused(true))
  await settleQueryNotifications()
  expect(screen.seen.diffShowWhitespace).toBe(true)
})

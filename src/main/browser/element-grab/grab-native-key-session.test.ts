import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { GrabNativeKeySession } from './grab-native-key-session'
import { withAgentInputInjection } from '../cdp/input/agent-input-injection'
import {
  BROWSER_INPUT_GUARD,
  BROWSER_INPUT_GUARD_ACK
} from '../../../shared/browser/element-grab/browser-input-guard'
import {
  GRAB_NATIVE_KEY_POLICY,
  GRAB_NATIVE_KEY_REPORT
} from '../../../shared/browser/element-grab/browser-grab-native-keys'

type Message = { token: string; revision: number }
type PageReport = Message & Record<string, unknown>

it('forwards a tool letter the page reports right after agent input, while the resume is still in flight', async () => {
  const guards: (Message & { suspended: boolean })[] = []
  const policies: (Message & { enabled: boolean })[] = []
  const frame = {
    send: (channel: string, payload: Message & { suspended: boolean }) => {
      if (channel === BROWSER_INPUT_GUARD) {
        guards.push(payload)
      }
    }
  }
  const guest = Object.assign(new EventEmitter(), {
    id: 83,
    mainFrame: frame,
    isDestroyed: () => false,
    setIgnoreMenuShortcuts: () => {},
    send: (channel: string, payload: Message & { enabled: boolean }) => {
      if (channel === GRAB_NATIVE_KEY_POLICY) {
        policies.push(payload)
      }
    }
  })
  const forwarded: string[] = []
  const host = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (_channel: string, payload: { key: string }) => forwarded.push(payload.key)
  })
  const fromPage = (channel: string, payload: PageReport): void => {
    guest.emit('ipc-message', { senderFrame: frame }, channel, payload)
  }
  const ackGuard = (): void => {
    const latest = guards.at(-1)
    if (latest) {
      fromPage(BROWSER_INPUT_GUARD_ACK, latest)
    }
  }

  const session = new GrabNativeKeySession(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session and guard use only id, mainFrame, send, isDestroyed and events.
    guest as unknown as Electron.WebContents,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host is used only for send, isDestroyed and events.
    host as unknown as Electron.WebContents,
    'page-1'
  )
  ackGuard()
  const enabled = session.setEnabled(true)
  const live = policies[0]
  fromPage(GRAB_NATIVE_KEY_REPORT, { ...live, ready: true })
  await expect(enabled).resolves.toBe(true)
  // The guard leaves its initial suspension before the page may report keys.
  guards.length = 0

  const injection = withAgentInputInjection(guest, async () => 'typed')
  await Promise.resolve()
  ackGuard()
  await expect(injection).resolves.toBe('typed')
  // The page applies the resume and the user presses a tool letter at once, under the policy it holds.
  ackGuard()
  await new Promise((resolve) => setTimeout(resolve, 0))
  fromPage(GRAB_NATIVE_KEY_REPORT, { token: live.token, revision: live.revision, key: 'd' })

  expect(forwarded).toEqual(['d'])
  expect(policies).toHaveLength(1)
  session.stop()
})

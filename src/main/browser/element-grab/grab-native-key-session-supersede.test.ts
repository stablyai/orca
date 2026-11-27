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

function keySession() {
  const guards: Message[] = []
  const policies: (Message & { enabled: boolean })[] = []
  const frame = {
    send: (channel: string, payload: Message) => {
      if (channel === BROWSER_INPUT_GUARD) {
        guards.push(payload)
      }
    }
  }
  const guest = Object.assign(new EventEmitter(), {
    id: 84,
    mainFrame: frame,
    isDestroyed: () => false,
    setIgnoreMenuShortcuts: () => {},
    send: (channel: string, payload: Message & { enabled: boolean }) => {
      if (channel === GRAB_NATIVE_KEY_POLICY) {
        policies.push(payload)
      }
    }
  })
  const host = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: () => {} })
  const fromPage = (channel: string, payload: Record<string, unknown>): void => {
    guest.emit('ipc-message', { senderFrame: frame }, channel, payload)
  }
  let unavailable = 0
  const session = new GrabNativeKeySession(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session and guard use only id, mainFrame, send, isDestroyed and events.
    guest as unknown as Electron.WebContents,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host is used only for send, isDestroyed and events.
    host as unknown as Electron.WebContents,
    'page-1',
    () => {},
    () => true,
    () => {
      unavailable++
    }
  )
  const ackGuard = (): void => {
    const latest = guards.at(-1)
    if (latest) {
      fromPage(BROWSER_INPUT_GUARD_ACK, latest)
    }
  }
  return { session, guest, policies, fromPage, ackGuard, unavailable: () => unavailable }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

it('agent input during activation leaves the activation and the session intact', async () => {
  const { session, guest, policies, fromPage, ackGuard, unavailable } = keySession()
  ackGuard()
  const activation = session.setEnabled(true)

  // Agent input runs before the page acknowledges the first policy.
  const injection = withAgentInputInjection(guest, async () => 'typed')
  await tick()
  ackGuard()
  await expect(injection).resolves.toBe('typed')
  // Its resume republishes the policy, superseding the activation's request.
  ackGuard()
  await tick()
  expect(policies.map((policy) => policy.revision)).toEqual([1, 2])
  fromPage(GRAB_NATIVE_KEY_REPORT, { ...policies[1], ready: true })

  await expect(activation).resolves.toBe(true)
  // Not torn down as unavailable, which would have retired the palette keys.
  expect(unavailable()).toBe(0)
  session.stop()
})

import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { setupGrabShortcutForwarding } from './browser-guest-grab-shortcuts'
import { withAgentInputInjection } from '../../../cdp/input/agent-input-injection'
import {
  BROWSER_INPUT_GUARD,
  BROWSER_INPUT_GUARD_ACK
} from '../../../../../shared/browser/element-grab/browser-input-guard'
import {
  GRAB_CHORD_POLICY,
  GRAB_CHORD_REPORT
} from '../../../../../shared/browser/element-grab/browser-grab-native-keys'

type Message = { token: string; revision: number }

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

it('delivers a grab chord the page reports right after agent input, while the resume is still in flight', async () => {
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
    id: 84,
    mainFrame: frame,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    setIgnoreMenuShortcuts: () => {},
    send: (channel: string, payload: Message & { enabled: boolean }) => {
      if (channel === GRAB_CHORD_POLICY) {
        policies.push(payload)
      }
    }
  })
  const toggles: string[] = []
  const renderer = {
    isDestroyed: () => false,
    send: (channel: string, _page: string, kind: string) => toggles.push(`${channel}:${kind}`)
  }
  const fromPage = (channel: string, payload: object): void => {
    guest.emit('ipc-message', { senderFrame: frame }, channel, payload)
  }
  const ackGuard = (): void => {
    const latest = guards.at(-1)
    if (latest) {
      fromPage(BROWSER_INPUT_GUARD_ACK, latest)
    }
  }

  const stop = setupGrabShortcutForwarding({
    browserTabId: 'page-1',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session and guard use only id, mainFrame, send, isDestroyed, isLoadingMainFrame and events.
    guest: guest as unknown as Electron.WebContents,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chord only sends to the renderer and checks isDestroyed.
    resolveRenderer: () => renderer as unknown as Electron.WebContents,
    hasActiveGrabOp: () => true
  })
  ackGuard()
  await settle()
  const live = policies.at(-1)
  if (!live?.enabled) {
    throw new Error('The chord policy was not published enabled')
  }
  fromPage(GRAB_CHORD_REPORT, { ...live, ready: true })
  await settle()
  const published = policies.length

  const injection = withAgentInputInjection(guest, async () => 'typed')
  await Promise.resolve()
  ackGuard()
  await expect(injection).resolves.toBe('typed')
  // The page applies the resume and the user presses the chord at once, under the policy it holds.
  ackGuard()
  await settle()
  const mod = process.platform === 'darwin'
  fromPage(GRAB_CHORD_REPORT, {
    token: live.token,
    revision: live.revision,
    input: { key: 'c', code: 'KeyC', meta: mod, control: !mod, alt: false, shift: false }
  })

  expect(toggles).toEqual(['browser:grabModeToggle:copy'])
  expect(policies).toHaveLength(published)
  stop()
})

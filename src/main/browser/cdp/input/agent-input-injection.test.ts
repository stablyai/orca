import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { registerAgentInputSuspension, withAgentInputInjection } from './agent-input-injection'
import { setBrowserInputPolicy } from './browser-input-guard'
import {
  BROWSER_INPUT_GUARD,
  BROWSER_INPUT_GUARD_ACK
} from '../../../../shared/browser/element-grab/browser-input-guard'

it('delivers guarded keyboard input after one current guard ACK, never waiting on policy round trips', async () => {
  const sent: { token: string; revision: number; suspended: boolean }[] = []
  const frame = {
    send: (channel: string, payload: { token: string; revision: number; suspended: boolean }) => {
      if (channel === BROWSER_INPUT_GUARD) {
        sent.push(payload)
      }
    }
  }
  const guest = Object.assign(target(), { mainFrame: frame })
  const ack = (message: { token: string; revision: number; suspended: boolean }): void => {
    guest.emit('ipc-message', { senderFrame: frame }, BROWSER_INPUT_GUARD_ACK, message)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard uses only mainFrame.send, on/off/once and id.
  setBrowserInputPolicy(guest as unknown as Electron.WebContents, 'chord', 'chord-token')
  ack(sent[0])
  // An active chord policy whose own round trip never completes.
  registerAgentInputSuspension(guest, () => new Promise<void>(() => {}))

  let delivered = false
  const injection = withAgentInputInjection(guest, async () => {
    delivered = true
    return 'typed'
  })
  await Promise.resolve()
  const suspend = sent.at(-1)
  if (!suspend?.suspended) {
    throw new Error('Missing guard suspension')
  }
  ack({ ...suspend, revision: suspend.revision - 1 })
  await Promise.resolve()
  expect(delivered).toBe(false)

  ack(suspend)
  // The resume guard message stays unacknowledged; the delivered result does not wait for it.
  await expect(injection).resolves.toBe('typed')
  expect(delivered).toBe(true)
  expect(sent.at(-1)?.suspended).toBe(false)
})

function target() {
  let menuIgnored = false
  return Object.assign(new EventEmitter(), {
    id: 71,
    isDestroyed: () => false,
    setIgnoreMenuShortcuts: (ignored: boolean) => {
      menuIgnored = ignored
    },
    menuIgnored: () => menuIgnored
  })
}

it('preserves delivered success and the original input error through a failed resume', async () => {
  const guest = target()
  registerAgentInputSuspension(guest, async (suspended) => {
    if (!suspended) {
      throw new Error('resume lost')
    }
  })
  await expect(withAgentInputInjection(guest, async () => 'delivered')).resolves.toBe('delivered')
  const original = new Error('input failed')
  await expect(
    withAgentInputInjection(guest, async () => {
      throw original
    })
  ).rejects.toBe(original)
  expect(guest.menuIgnored()).toBe(false)
})

it('requires a fresh acknowledged disable when another input overlaps a pending resume', async () => {
  const guest = target()
  let resumed: (() => void) | undefined
  const resumeStarted = new Promise<void>((resolve) => {
    resumed = resolve
  })
  let releaseResume: (() => void) | undefined
  const resume = new Promise<void>((resolve) => {
    releaseResume = resolve
  })
  let holdDisable = false
  let releaseDisable: (() => void) | undefined
  const disable = new Promise<void>((resolve) => {
    releaseDisable = resolve
  })
  registerAgentInputSuspension(guest, async (suspended) => {
    if (suspended) {
      if (holdDisable) {
        await disable
      }
    } else {
      resumed?.()
      await resume
    }
  })
  const delivered: string[] = []
  const first = withAgentInputInjection(guest, async () => {
    delivered.push('first')
    return 'first'
  })
  await resumeStarted
  holdDisable = true
  const second = withAgentInputInjection(guest, async () => {
    delivered.push('second')
    return 'second'
  })
  await Promise.resolve()
  expect(delivered).toEqual(['first'])
  releaseDisable?.()
  releaseResume?.()
  await expect(first).resolves.toBe('first')
  await expect(second).resolves.toBe('second')
  expect(delivered).toEqual(['first', 'second'])
  expect(guest.menuIgnored()).toBe(false)
})

it('refuses input after an unacknowledged retired policy until a fresh document is ready', async () => {
  const guest = target()
  const unregister = registerAgentInputSuspension(guest, async (suspended) => {
    if (!suspended) {
      unregister()
      throw new Error('resume lost')
    }
  })
  await expect(withAgentInputInjection(guest, async () => 'delivered')).resolves.toBe('delivered')
  let delivered = false
  await expect(
    withAgentInputInjection(guest, async () => {
      delivered = true
    })
  ).rejects.toThrow('acknowledged suspension')
  expect(delivered).toBe(false)
  guest.emit('dom-ready')
  await expect(withAgentInputInjection(guest, async () => 'new document')).resolves.toBe(
    'new document'
  )
})

it('waits for every active shortcut policy before delivering input', async () => {
  const guest = target()
  let release: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  registerAgentInputSuspension(guest, async (suspended) => {
    if (suspended) {
      await ready
    }
  })
  registerAgentInputSuspension(guest, async () => {})
  let delivered = false
  const injection = withAgentInputInjection(guest, async () => {
    delivered = true
  })
  await Promise.resolve()
  expect(delivered).toBe(false)
  release?.()
  await injection
  expect(delivered).toBe(true)
})

it('allows pointer work without a key ACK while still guarding nested keyboard delivery', async () => {
  const guest = target()
  const unavailable = new Error('key policy unavailable')
  registerAgentInputSuspension(guest, async () => {
    throw unavailable
  })
  const result = await withAgentInputInjection(
    guest,
    async () => {
      expect(guest.menuIgnored()).toBe(true)
      await expect(withAgentInputInjection(guest, async () => 'key')).rejects.toBe(unavailable)
      return 'pointer delivered'
    },
    { keyboard: false }
  )
  expect(result).toBe('pointer delivered')
  expect(guest.menuIgnored()).toBe(false)
})

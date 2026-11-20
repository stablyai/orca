import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { registerAgentInputSuspension, withAgentInputInjection } from './agent-input-injection'

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

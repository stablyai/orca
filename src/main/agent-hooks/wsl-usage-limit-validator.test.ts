import { afterEach, expect, it } from 'vitest'
import { SshChannelMultiplexer, type MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import { RelayDispatcher } from '../../wsl-guest/dispatcher'
import { TERMINAL_USAGE_LIMIT_SOURCE_METHOD } from '../../shared/terminal-usage-limit-source-validation'
import { captureWslUsageLimitValidator } from './wsl-usage-limit-validator'
import type { WslRelayDistroState } from './wsl-hook-relay-state'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

function link(handler?: (params: Record<string, unknown>) => Promise<unknown>) {
  let feed: ((data: Buffer) => void) | undefined
  const callbacks: ((data: Buffer) => void)[] = []
  const transport: MultiplexerTransport = {
    write: (data, settled) => {
      setImmediate(() => {
        feed?.(data)
        settled?.({ ok: true })
      })
    },
    supportsWriteSettlement: true,
    onData: (callback) => {
      callbacks.push(callback)
    },
    onClose: () => {}
  }
  const guest = new RelayDispatcher(
    (data, settled) => {
      setImmediate(() => {
        for (const callback of callbacks) {
          callback(data)
        }
        settled({ ok: true })
      })
      return true
    },
    { supportsWriteCallback: true }
  )
  feed = (data) => guest.feed(data)
  const mux = new SshChannelMultiplexer(transport)
  if (handler) {
    guest.onRequest(TERMINAL_USAGE_LIMIT_SOURCE_METHOD, handler)
  }
  cleanups.push(() => {
    mux.dispose()
    guest.dispose()
  })
  const state: WslRelayDistroState = {
    distro: 'Ubuntu',
    phase: 'running',
    mux,
    launchKinds: new Set(),
    failures: 0,
    cooldownUntil: 0
  }
  const states = new Map([['ubuntu', state]])
  let allowed = true
  return {
    state,
    states,
    capture: () => captureWslUsageLimitValidator('wsl:Ubuntu', states, () => allowed)!,
    disallow: () => {
      allowed = false
    }
  }
}
const request = { paneKey: 'pane', sessionId: 'session', turnEndedAt: 42, source: 'codex' as const }

it('refuses a retired mux response and never transfers its authorization to a replacement', async () => {
  let answer: ((value: unknown) => void) | undefined
  let requested: (() => void) | undefined
  const called = new Promise<void>((resolve) => {
    requested = resolve
  })
  const host = link(async () => {
    requested?.()
    return new Promise((resolve) => {
      answer = resolve
    })
  })
  const captured = host.capture()
  expect(captured.isCurrent()).toBe(true)
  const pending = captured.validateSource(request)
  await called
  const replacement = link(async () => ({ status: 'current' }))
  host.states.set('ubuntu', replacement.state)
  answer?.({ status: 'current' })
  expect(await pending).toEqual({ status: 'changed' })
  expect(captured.isCurrent()).toBe(false)
  expect(await host.capture().validateSource(request)).toEqual({ status: 'current' })
  host.disallow()
  expect(host.capture()).toBeNull()
})

it('makes unsupported or unrecognized guest replies unavailable without disrupting the link', async () => {
  const older = link()
  expect(await older.capture().validateSource(request)).toEqual({ status: 'unavailable' })
  expect(older.capture().isCurrent()).toBe(true)
  const unknown = link(async () => ({ status: 'other' }))
  expect(await unknown.capture().validateSource(request)).toEqual({ status: 'unavailable' })
})

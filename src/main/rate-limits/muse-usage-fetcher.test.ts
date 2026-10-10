import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { readMuseUsageViaServe, type MuseProbeChild } from './muse-usage-fetcher'
import { mapMuseUsage, parseMuseSubscriptionUsage } from './muse-usage-response'

const USAGE = {
  window: {
    usedPercent: 12,
    windowDurationMins: 300,
    resetsAtMs: 1_791_574_634_000
  },
  weekly: { usedPercent: 42, resetsAtMs: 1_791_763_200_000 },
  tier: '27681631238169137',
  observedAtMs: 1_791_556_639_356
}

type FakeOptions = {
  turnTerminal?: string
  pushUsage?: boolean
  readUsage?: unknown
}

function fakeMuseServe(options: FakeOptions = {}): MuseProbeChild & { sent: string[] } {
  const stdout = new EventEmitter()
  const events = new EventEmitter()
  const sent: string[] = []
  const emit = (message: Record<string, unknown>): void => {
    queueMicrotask(() =>
      stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`))
    )
  }
  const child = {
    sent,
    stdin: {
      write(data: string) {
        for (const line of data.split('\n').filter(Boolean)) {
          const message = JSON.parse(line) as { id?: number; method: string }
          sent.push(message.method)
          if (message.method === 'initialize') {
            emit({ id: message.id, result: { serverInfo: { name: 'muse' } } })
          } else if (message.method === 'session/start') {
            emit({
              id: message.id,
              result: { session: { sessionId: 'session-1' } }
            })
          } else if (message.method === 'turn/start') {
            emit({ id: message.id, result: { status: 'accepted' } })
            emit({
              method: 'turn/completed',
              params: { terminal: options.turnTerminal ?? 'completed' }
            })
            if (options.pushUsage !== false) {
              emit({ method: 'usage/changed', params: USAGE })
            }
          } else if (message.method === 'usage/read') {
            emit({ id: message.id, result: options.readUsage ?? {} })
          }
        }
        return true
      },
      end() {
        return undefined
      }
    },
    stdout,
    on(event: string, listener: Parameters<EventEmitter['on']>[1]) {
      events.on(event, listener)
      return child
    },
    kill() {
      return true
    }
  }
  return child
}

describe('parseMuseSubscriptionUsage', () => {
  it('accepts the MSP usage payload', () => {
    expect(parseMuseSubscriptionUsage(USAGE)?.window.usedPercent).toBe(12)
  })

  it('rejects incomplete payloads', () => {
    expect(parseMuseSubscriptionUsage({})).toBeNull()
    expect(parseMuseSubscriptionUsage({ window: USAGE.window })).toBeNull()
  })
})

describe('mapMuseUsage', () => {
  it('maps the 5-hour and weekly windows', () => {
    const limits = mapMuseUsage(parseMuseSubscriptionUsage(USAGE)!)
    expect(limits).toMatchObject({
      provider: 'muse',
      status: 'ok',
      session: {
        usedPercent: 12,
        windowMinutes: 300,
        resetsAt: USAGE.window.resetsAtMs
      },
      weekly: {
        usedPercent: 42,
        windowMinutes: 10_080,
        resetsAt: USAGE.weekly.resetsAtMs
      },
      updatedAt: USAGE.observedAtMs
    })
  })

  it('clamps over-quota percentages to the meter range', () => {
    const over = { ...USAGE, window: { ...USAGE.window, usedPercent: 130 } }
    expect(mapMuseUsage(parseMuseSubscriptionUsage(over)!).session?.usedPercent).toBe(100)
  })
})

describe('readMuseUsageViaServe', () => {
  it('reads the usage/changed push after one minimal turn', async () => {
    const child = fakeMuseServe()
    const limits = await readMuseUsageViaServe({
      child,
      workspaceRoot: '/tmp'
    })
    expect(limits.status).toBe('ok')
    expect(limits.weekly?.usedPercent).toBe(42)
    expect(child.sent).toEqual(['initialize', 'initialized', 'session/start', 'turn/start'])
  })

  it('falls back to usage/read when no push arrives', async () => {
    const child = fakeMuseServe({
      pushUsage: false,
      readUsage: { usage: USAGE }
    })
    const limits = await readMuseUsageViaServe({
      child,
      workspaceRoot: '/tmp'
    })
    expect(limits.status).toBe('ok')
    expect(child.sent).toContain('usage/read')
  })

  it('reports unavailable when Muse observed no usage', async () => {
    const child = fakeMuseServe({ pushUsage: false })
    const limits = await readMuseUsageViaServe({
      child,
      workspaceRoot: '/tmp'
    })
    expect(limits.status).toBe('unavailable')
  })

  it('reports an error when the probe turn fails', async () => {
    const child = fakeMuseServe({ turnTerminal: 'failed' })
    const limits = await readMuseUsageViaServe({
      child,
      workspaceRoot: '/tmp'
    })
    expect(limits.status).toBe('error')
    expect(limits.error).toContain('muse login')
  })
})

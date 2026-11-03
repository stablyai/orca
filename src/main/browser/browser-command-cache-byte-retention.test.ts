import { describe, expect, it } from 'vitest'
import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import { BrowserHostCommandLedger } from '../runtime/browser-host/browser-host-command-ledger'
import { BrowserClientHostCommandDispatcher } from './browser-client-host-command-dispatcher'

const authority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'host-a',
  browserHostGeneration: 1,
  pageCommandProtocolVersion: 1
}
const completed: BrowserClientHostCommandResult = { status: 'completed' }
const large: BrowserClientHostCommandResult = { status: 'completed', value: 'x'.repeat(4_000) }
type ByteLimits = { maxCachedResultBytes: number; maxCachedResultBytesPerPage: number }
type Command = BrowserClientHostCommandEvent['command']

function resultParams(
  event: BrowserClientHostCommandEvent,
  result: BrowserClientHostCommandResult
) {
  return { ...event, result }
}

function createDriver(kind: 'desktop' | 'runtime', limits: ByteLimits) {
  let calls = 0
  let nextResult = completed
  const sequences = new Map<string, number>()
  const dispatcher = new BrowserClientHostCommandDispatcher({
    authority,
    ...limits,
    handler: () => {
      calls += 1
      return nextResult
    }
  })
  const ledger = new BrowserHostCommandLedger({ authority, ...limits })
  ledger.attach(() => {
    calls += 1
  })
  return {
    calls: () => calls,
    async run(page: string, body?: Command, result = completed) {
      const sequence = (sequences.get(page) ?? 0) + 1
      sequences.set(page, sequence)
      const command = body ?? {
        type: 'createPage',
        browserProfileId: 'default',
        executionHostKey: 'host-a'
      }
      if (kind === 'runtime') {
        const issued = ledger.issue({
          browserPageId: page,
          pageHostGeneration: 1,
          command
        })
        expect(ledger.settle(resultParams(issued.event, result))).toBe(true)
        expect(await issued.result).toEqual(result)
        return issued.event
      }
      const event: BrowserClientHostCommandEvent = {
        ...authority,
        type: 'command',
        pageCommandProtocolVersion: 1,
        browserPageId: page,
        pageHostGeneration: 1,
        commandSequence: sequence,
        commandId: `${page}-${sequence}`,
        command
      }
      nextResult = result
      expect(await dispatcher.dispatch(event)).toEqual(result)
      nextResult = completed
      return event
    },
    replay(event: BrowserClientHostCommandEvent, result = completed) {
      if (kind === 'runtime') {
        expect(ledger.settle(resultParams(event, result))).toBe(false)
      } else {
        void dispatcher.dispatch(event)
      }
    },
    close: async () => {
      ledger.close()
      await dispatcher.close()
    }
  }
}

const navigate: Command = { type: 'navigate', url: 'https://example.invalid/' }

describe.each(['desktop', 'runtime'] as const)('%s browser command replay byte limits', (kind) => {
  it('expires old payloads at the page byte limit and replays the surviving result', async () => {
    const driver = createDriver(kind, {
      maxCachedResultBytes: 20_000,
      maxCachedResultBytesPerPage: 6_000
    })
    try {
      await driver.run('page-a')
      const first = await driver.run('page-a', navigate, large)
      const second = await driver.run('page-a', navigate, large)
      const last = await driver.run('page-a', navigate, large)
      expect(() => driver.replay(first, large)).toThrow('browser_host_command_result_expired')
      expect(() => driver.replay(second, large)).toThrow('browser_host_command_result_expired')
      expect(() => driver.replay(last, large)).not.toThrow()
      expect(driver.calls()).toBe(4)
    } finally {
      await driver.close()
    }
  })

  it('shares the byte limit across pages and permits new work after eviction', async () => {
    const driver = createDriver(kind, {
      maxCachedResultBytes: 10_000,
      maxCachedResultBytesPerPage: 8_000
    })
    try {
      const entries: BrowserClientHostCommandEvent[] = []
      for (const page of ['page-a', 'page-b', 'page-c']) {
        await driver.run(page)
        entries.push(await driver.run(page, navigate, large))
      }
      expect(() => driver.replay(entries[0], large)).toThrow('browser_host_command_result_expired')
      expect(() => driver.replay(entries[1], large)).not.toThrow()
      expect(() => driver.replay(entries[2], large)).not.toThrow()
      const next = await driver.run('page-a', navigate)
      expect(() => driver.replay(next)).not.toThrow()
      expect(driver.calls()).toBe(7)
    } finally {
      await driver.close()
    }
  })

  it('charges inputs and UTF-8 results together without rejecting completed commands', async () => {
    const driver = createDriver(kind, {
      maxCachedResultBytes: 3_000,
      maxCachedResultBytesPerPage: 3_000
    })
    try {
      await driver.run('page-a')
      const combined = await driver.run(
        'page-a',
        { type: 'automation', method: 'browser.eval', params: { expression: 'x'.repeat(1_400) } },
        { status: 'completed', value: 'y'.repeat(1_400) }
      )
      expect(() => driver.replay(combined)).toThrow('browser_host_command_result_expired')
      const unicode = await driver.run('page-a', navigate, {
        status: 'completed',
        value: '漢'.repeat(950)
      })
      expect(() => driver.replay(unicode)).toThrow('browser_host_command_result_expired')
      const next = await driver.run('page-a', navigate)
      expect(() => driver.replay(next)).not.toThrow()
      expect(driver.calls()).toBe(4)
    } finally {
      await driver.close()
    }
  })
})

async function collect(): Promise<void> {
  if (!global.gc) {
    throw new Error('This retention test requires --expose-gc')
  }
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    global.gc()
  }
}

describe.each(['desktop', 'runtime'] as const)('%s cached payload ownership', (kind) => {
  it('releases evicted result objects while keeping the newest available until close', async () => {
    const driver = createDriver(kind, {
      maxCachedResultBytes: 2_000,
      maxCachedResultBytesPerPage: 2_000
    })
    const remember = async (): Promise<WeakRef<object>> => {
      const value = { text: 'x'.repeat(1_000) }
      await driver.run('page-a', navigate, { status: 'completed', value })
      return new WeakRef(value)
    }
    const retained: WeakRef<object>[] = []
    try {
      await driver.run('page-a')
      for (let index = 0; index < 20; index += 1) {
        retained.push(await remember())
      }
      await collect()
      expect(retained.slice(0, -1).every((value) => value.deref() === undefined)).toBe(true)
      expect(retained.at(-1)?.deref()).toBeDefined()
    } finally {
      await driver.close()
    }
    await collect()
    expect(retained.every((value) => value.deref() === undefined)).toBe(true)
  })
})

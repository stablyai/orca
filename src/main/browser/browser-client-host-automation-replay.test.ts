import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserClientHostCommandEvent,
  type BrowserClientHostCommandResult,
  type BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import * as commandState from './browser-client-host-command-state'
import { BrowserClientHostCommandDispatcher } from './browser-client-host-command-dispatcher'

const authority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'host-a',
  browserHostGeneration: 2,
  pageCommandProtocolVersion: 1
}

function event(
  command: BrowserClientHostCommandEvent['command'],
  commandSequence = 2
): BrowserClientHostCommandEvent {
  return {
    ...authority,
    pageCommandProtocolVersion: 1,
    type: 'command',
    browserPageId: 'page-a',
    pageHostGeneration: 1,
    commandSequence,
    commandId: `command-${commandSequence}`,
    command
  }
}

function wireCopy(command: BrowserClientHostCommandEvent): BrowserClientHostCommandEvent {
  return BrowserClientHostCommandEvent.parse(JSON.parse(JSON.stringify(command)))
}

const create = event(
  { type: 'createPage', browserProfileId: 'default', executionHostKey: 'remote-host' },
  1
)
const snapshot = event({ type: 'automation', method: 'browser.snapshot', params: {} })

describe('automation command replay', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('preserves nested own __proto__ data without a platform clone', async () => {
    vi.stubGlobal('structuredClone', () => {
      throw new Error('platform clone must not run')
    })
    const handler = vi.fn((accepted: BrowserClientHostCommandEvent) => {
      if (accepted.command.type === 'automation') {
        const nested = accepted.command.params.nested
        if (nested === null || typeof nested !== 'object') {
          throw new Error('nested object required')
        }
        expect(Object.getPrototypeOf(nested)).toBe(Object.prototype)
        expect(Object.hasOwn(nested, '__proto__')).toBe(true)
        const data = Object.getOwnPropertyDescriptor(nested, '__proto__')!.value
        expect(data).toEqual({ value: 1 })
        expect(Object.isFrozen(nested)).toBe(true)
        expect(Object.isFrozen(data)).toBe(true)
        expect(Reflect.set(data, 'value', 2)).toBe(false)
      }
      return { status: 'completed' as const }
    })
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
    await dispatcher.dispatch(create)
    const command = wireCopy(
      event({
        type: 'automation',
        method: 'browser.eval',
        params: JSON.parse('{"nested":{"__proto__":{"value":1},"ok":1}}')
      })
    )
    const original = dispatcher.dispatch(command)
    await expect(original).resolves.toEqual({ status: 'completed' })
    expect(dispatcher.dispatch(wireCopy(command))).toBe(original)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('executes and replays schema-accepted depth 3000 JSON without recursive traversal', async () => {
    const json = `${'{"n":'.repeat(3000)}0${'}'.repeat(3000)}`
    expect(json.length).toBe(18001)
    const handler = vi.fn((accepted: BrowserClientHostCommandEvent) => {
      if (accepted.command.type === 'automation') {
        let node: unknown = accepted.command.params
        let depth = 0
        while (node !== null && typeof node === 'object') {
          expect(Object.isFrozen(node)).toBe(true)
          node = Object.getOwnPropertyDescriptor(node, 'n')!.value
          depth += 1
        }
        expect(depth).toBe(3000)
        expect(node).toBe(0)
      }
      return { status: 'completed' as const }
    })
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
    await dispatcher.dispatch(create)
    const command = wireCopy(
      event({ type: 'automation', method: 'browser.eval', params: JSON.parse(json) })
    )
    const original = dispatcher.dispatch(command)
    await expect(original).resolves.toEqual({ status: 'completed' })
    expect(dispatcher.dispatch(wireCopy(command))).toBe(original)
    const changed = wireCopy(
      event({
        type: 'automation',
        method: 'browser.eval',
        params: JSON.parse(json.replace('0', '1'))
      })
    )
    expect(() => dispatcher.dispatch(changed)).toThrow('browser_host_command_sequence_conflict')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('snapshots only newly admitted commands, never duplicates or rejected input', async () => {
    const snapshotSpy = vi.spyOn(commandState, 'snapshotCommandEvent')
    const handler = vi.fn(() => ({ status: 'completed' as const }))
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
    await dispatcher.dispatch(create)
    const original = dispatcher.dispatch(wireCopy(snapshot))
    for (let index = 0; index < 5; index += 1) {
      expect(dispatcher.dispatch(wireCopy(snapshot))).toBe(original)
    }
    await original
    expect(dispatcher.dispatch(wireCopy(snapshot))).toBe(original)
    expect(() => dispatcher.dispatch({ ...snapshot, authorityEpoch: 'stale' })).toThrow()
    expect(() => dispatcher.dispatch({ ...snapshot, commandSequence: 4 })).toThrow()
    expect(() => dispatcher.dispatch({ ...snapshot, pageHostGeneration: 0 })).toThrow()
    expect(snapshotSpy).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('snapshots nested caller input and prevents handler mutation of replay identity', async () => {
    const handler = vi.fn((accepted: BrowserClientHostCommandEvent) => {
      if (accepted.command.type === 'automation') {
        const acceptedParams = accepted.command.params
        expect(Object.isFrozen(acceptedParams)).toBe(true)
        expect(Object.isFrozen(acceptedParams.nested)).toBe(true)
        if (Array.isArray(acceptedParams.nested)) {
          expect(Object.isFrozen(acceptedParams.nested[0])).toBe(true)
        }
        expect(() => {
          acceptedParams.nested = []
        }).toThrow(TypeError)
      }
      return { status: 'completed' as const }
    })
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
    await dispatcher.dispatch(create)
    const params = { nested: [{ value: 'original' }] }
    const command = event({ type: 'automation', method: 'browser.eval', params })
    const originalWireCommand = wireCopy(command)
    const original = dispatcher.dispatch(command)
    params.nested[0]!.value = 'mutated'
    await expect(original).resolves.toEqual({ status: 'completed' })
    expect(dispatcher.dispatch(originalWireCommand)).toBe(original)
    expect(() => dispatcher.dispatch(wireCopy(command))).toThrow(
      'browser_host_command_sequence_conflict'
    )
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it.each(['browser.snapshot', 'browser.eval'] as const)(
    'replays completed %s exactly once',
    async (method) => {
      const handler = vi.fn(() => ({ status: 'completed' as const, value: { result: [1, null] } }))
      const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
      await dispatcher.dispatch(create)
      const command = event({ type: 'automation', method, params: { nested: [{ value: true }] } })
      const original = dispatcher.dispatch(wireCopy(command))
      await original
      expect(dispatcher.dispatch(wireCopy(command))).toBe(original)
      expect(handler).toHaveBeenCalledTimes(2)
    }
  )

  it('joins an in-flight duplicate with reordered nested JSON keys', async () => {
    let finish = (_value: BrowserClientHostCommandResult): void => {}
    const pending = new Promise<BrowserClientHostCommandResult>((resolve) => {
      finish = resolve
    })
    const handler = vi.fn().mockResolvedValueOnce({ status: 'completed' }).mockReturnValue(pending)
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
    await dispatcher.dispatch(create)
    const original = dispatcher.dispatch(
      event({
        type: 'automation',
        method: 'browser.eval',
        params: { script: 'example', args: [{ first: 1, second: [null, true, 'text'] }] }
      })
    )
    const replay = dispatcher.dispatch(
      wireCopy(
        event({
          type: 'automation',
          method: 'browser.eval',
          params: { args: [{ second: [null, true, 'text'], first: 1 }], script: 'example' }
        })
      )
    )
    expect(replay).toBe(original)
    finish({ status: 'completed', value: 'done' })
    await expect(replay).resolves.toEqual({ status: 'completed', value: 'done' })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it.each([
    { type: 'automation', method: 'browser.click', params: { nested: { a: [1, 2], b: null } } },
    { type: 'automation', method: 'browser.snapshot', params: { nested: { a: [2, 1], b: null } } },
    { type: 'automation', method: 'browser.snapshot', params: { nested: { a: [1, 2], b: false } } },
    {
      type: 'automation',
      method: 'browser.snapshot',
      params: { nested: { a: [1, '2'], b: null } }
    },
    { type: 'automation', method: 'browser.snapshot', params: { nested: { a: [1, 2] } } },
    {
      type: 'automation',
      method: 'browser.snapshot',
      params: { nested: { a: [1, 2], b: null, c: 3 } }
    },
    { type: 'navigate', url: 'https://example.test' }
  ] as const)('rejects different payload %j without executing it', async (payload) => {
    const handler = vi.fn().mockResolvedValue({ status: 'completed' })
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
    await dispatcher.dispatch(create)
    await dispatcher.dispatch(
      event({
        type: 'automation',
        method: 'browser.snapshot',
        params: { nested: { a: [1, 2], b: null } }
      })
    )
    expect(() => dispatcher.dispatch(wireCopy(event(payload)))).toThrow(
      'browser_host_command_sequence_conflict'
    )
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('keeps lease, page, generation, sequence and ID outside the payload identity', async () => {
    const handler = vi.fn().mockResolvedValue({ status: 'completed' })
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
    await dispatcher.dispatch(create)
    await dispatcher.dispatch(snapshot)
    for (const patch of [
      { authorityRuntimeId: 'other' },
      { authorityEpoch: 'other' },
      { browserHostClientId: 'other' },
      { browserHostGeneration: 3 }
    ]) {
      expect(() => dispatcher.dispatch({ ...snapshot, ...patch })).toThrow(
        'browser_host_command_authority_stale'
      )
    }
    expect(() => dispatcher.dispatch({ ...snapshot, pageHostGeneration: 2 })).toThrow(
      'browser_host_page_replacement_requires_retirement'
    )
    expect(() => dispatcher.dispatch({ ...snapshot, commandSequence: 3 })).toThrow(
      'browser_host_command_id_conflict'
    )
    expect(() => dispatcher.dispatch({ ...snapshot, commandSequence: 4 })).toThrow(
      'browser_host_command_sequence_gap'
    )
    expect(() => dispatcher.dispatch({ ...snapshot, commandId: 'other' })).toThrow(
      'browser_host_command_sequence_conflict'
    )
    await dispatcher.dispatch({ ...create, browserPageId: 'page-b' })
    const otherPage = dispatcher.dispatch({ ...snapshot, browserPageId: 'page-b' })
    expect(otherPage).not.toBe(dispatcher.dispatch(snapshot))
    await otherPage
    expect(handler).toHaveBeenCalledTimes(4)
    await dispatcher.retirePage('page-a', 1)
    await dispatcher.dispatch({ ...create, pageHostGeneration: 2 })
    expect(() => dispatcher.dispatch(snapshot)).toThrow('browser_host_page_generation_stale')
    await dispatcher.dispatch({ ...snapshot, pageHostGeneration: 2 })
    expect(handler).toHaveBeenCalledTimes(6)
  })

  it('caches handler failure and refuses expired results without rerunning', async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: 'completed' })
      .mockRejectedValue(new Error('failed'))
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority,
      handler,
      maxCachedResultsPerPage: 1
    })
    await dispatcher.dispatch(create)
    const original = dispatcher.dispatch(snapshot)
    await expect(original).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_host_command_failed'
    })
    expect(dispatcher.dispatch(wireCopy(snapshot))).toBe(original)
    await dispatcher.dispatch({ ...snapshot, commandId: 'next', commandSequence: 3 })
    expect(() => dispatcher.dispatch(snapshot)).toThrow('browser_host_command_result_expired')
    expect(handler).toHaveBeenCalledTimes(3)
  })
})

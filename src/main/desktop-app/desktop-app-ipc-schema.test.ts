import { describe, expect, it } from 'vitest'
import { parseSendInputArgs, parseTargetArgs } from './desktop-app-ipc-schema'

describe('desktop app IPC argument parsing', () => {
  it('accepts a window target and rejects ids that are not positive integers', () => {
    expect(parseTargetArgs({ windowId: 7, pid: 42 }, 'c')).toEqual({ windowId: 7, pid: 42 })
    expect(() => parseTargetArgs({ windowId: 0, pid: 42 }, 'c')).toThrow('c: invalid arguments')
    expect(() => parseTargetArgs({ windowId: 1.5, pid: 42 }, 'c')).toThrow()
    expect(() => parseTargetArgs({ windowId: 1 }, 'c')).toThrow()
    expect(() => parseTargetArgs(null, 'c')).toThrow()
  })

  it('accepts every input kind and rejects unknown kinds and bad numbers', () => {
    const target = { windowId: 7, pid: 42 }
    const click = { kind: 'click', x: 1, y: 2, button: 'left', clickCount: 1 }
    expect(parseSendInputArgs({ ...target, input: click }, 'c').input).toEqual(click)
    expect(() =>
      parseSendInputArgs({ ...target, input: { kind: 'text', text: 'hi' } }, 'c')
    ).not.toThrow()
    expect(() =>
      parseSendInputArgs({ ...target, input: { kind: 'key', key: 'cmd+a' } }, 'c')
    ).not.toThrow()
    expect(() =>
      parseSendInputArgs({ ...target, input: { ...click, x: Number.NaN } }, 'c')
    ).toThrow()
    expect(() =>
      parseSendInputArgs({ ...target, input: { kind: 'shell', cmd: 'ls' } }, 'c')
    ).toThrow()
  })
})

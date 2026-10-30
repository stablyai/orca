import { describe, expect, it, vi } from 'vitest'
import {
  HIDDEN_WINDOW_FRAME_PUMP_INTERVAL_MS,
  formatHiddenWindowFramePumpArgument
} from '../shared/hidden-window-frame-pump'
import {
  installHiddenWindowFramePump,
  startHiddenWindowFramePump
} from './hidden-window-frame-pump'

function harness(initial?: { value: string; priority: string }) {
  const props = new Map<string, { value: string; priority: string }>()
  if (initial) {
    props.set('background-color', initial)
  }
  const history: string[] = []
  const style = {
    getPropertyValue: (name: string) => props.get(name)?.value ?? '',
    getPropertyPriority: (name: string) => props.get(name)?.priority ?? '',
    setProperty: (name: string, value: string | null, priority = '') => {
      props.set(name, { value: value ?? '', priority })
      history.push(`set ${value} ${priority}`.trim())
      return undefined
    },
    removeProperty: (name: string) => {
      props.delete(name)
      history.push('remove')
      return ''
    }
  }
  const frames: (() => void)[] = []
  let tick: (() => void) | null = null
  let intervalMs = 0
  let cancelled = false
  const stop = startHiddenWindowFramePump({
    rootStyle: () => style,
    requestAnimationFrame: (callback) => frames.push(callback),
    every: (callback, ms) => {
      tick = callback
      intervalMs = ms
      return () => {
        cancelled = true
      }
    }
  })
  const runFrame = () => frames.shift()?.()
  return {
    props,
    history,
    frames,
    stop,
    tick: () => tick?.(),
    runFrame,
    intervalMs: () => intervalMs,
    cancelled: () => cancelled
  }
}

describe('startHiddenWindowFramePump', () => {
  it('damages exactly one frame per interval and removes the style it added', () => {
    const h = harness()
    expect(h.intervalMs()).toBe(HIDDEN_WINDOW_FRAME_PUMP_INTERVAL_MS)

    h.tick()
    h.runFrame()
    expect(h.props.get('background-color')?.value).toBe('rgb(1, 1, 1)')
    h.runFrame()

    expect(h.props.has('background-color')).toBe(false)
    expect(h.history).toEqual(['set rgb(1, 1, 1)', 'remove'])
  })

  it('restores an existing inline background and its priority exactly', () => {
    const h = harness({ value: 'red', priority: 'important' })

    h.tick()
    h.runFrame()
    h.runFrame()

    expect(h.props.get('background-color')).toEqual({ value: 'red', priority: 'important' })
  })

  it('does not start a second flip while one is in flight', () => {
    const h = harness()

    h.tick()
    h.tick()

    expect(h.frames).toHaveLength(1)
  })

  it('cancels the interval on stop but still restores a flip in flight', () => {
    const h = harness()
    h.tick()
    h.runFrame()

    h.stop()
    h.runFrame()
    h.tick()

    expect(h.cancelled()).toBe(true)
    expect(h.props.has('background-color')).toBe(false)
    expect(h.frames).toHaveLength(0)
  })
})

describe('installHiddenWindowFramePump', () => {
  function deps() {
    const every = vi.fn((_callback: () => void, _ms: number) => vi.fn())
    return { rootStyle: () => null, requestAnimationFrame: vi.fn(), every }
  }

  it('does not start without the flag main stamps', () => {
    const d = deps()
    const onStopRequest = vi.fn()
    installHiddenWindowFramePump(['--other'], onStopRequest, d)

    expect(d.every).not.toHaveBeenCalled()
    expect(onStopRequest).not.toHaveBeenCalled()
  })

  it('starts with the flag and hands main the stop', () => {
    const d = deps()
    let stop: (() => void) | undefined
    installHiddenWindowFramePump([formatHiddenWindowFramePumpArgument()], (s) => (stop = s), d)
    const cancel = d.every.mock.results[0]?.value

    stop?.()

    expect(cancel).toHaveBeenCalledOnce()
  })
})

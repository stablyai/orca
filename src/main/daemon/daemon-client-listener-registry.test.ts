import { describe, expect, it } from 'vitest'
import { DaemonClientListeners } from './daemon-client-listener-registry'

describe('DaemonClientListeners', () => {
  it('drops only the listener that asked, and a repeat disposal evicts nobody', () => {
    const listeners = new DaemonClientListeners<() => void>()
    const seen: string[] = []
    const disposeFirst = listeners.add(() => seen.push('first'))
    listeners.add(() => seen.push('second'))

    disposeFirst()
    listeners.each((listener) => listener())
    expect(seen).toEqual(['second'])

    disposeFirst()
    listeners.each((listener) => listener())
    expect(seen).toEqual(['second', 'second'])
  })

  it('gives the same function registered twice two independent disposers', () => {
    const listeners = new DaemonClientListeners<() => void>()
    let calls = 0
    const listener = (): void => {
      calls += 1
    }
    const disposeOne = listeners.add(listener)
    listeners.add(listener)

    disposeOne()
    listeners.each((each) => each())
    expect(calls).toBe(1)
  })
})

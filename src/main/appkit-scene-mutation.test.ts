import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferAppKitSceneMutation } from './appkit-scene-mutation'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('deferAppKitSceneMutation', () => {
  it('runs the mutation on a later turn, never inside the caller stack', () => {
    const mutate = vi.fn()

    deferAppKitSceneMutation(mutate)
    expect(mutate).not.toHaveBeenCalled()

    vi.advanceTimersByTime(0)
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('keeps scheduled mutations in call order', () => {
    const order: string[] = []

    deferAppKitSceneMutation(() => order.push('first'))
    deferAppKitSceneMutation(() => order.push('second'))
    vi.advanceTimersByTime(0)

    expect(order).toEqual(['first', 'second'])
  })
})

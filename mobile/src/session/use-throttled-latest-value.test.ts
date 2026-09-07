import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThrottledLatestValue } from './use-throttled-latest-value'

describe('useThrottledLatestValue', () => {
  let renderer: ReactTestRenderer | null = null
  let latest: string | undefined

  function Harness({ value }: { value: string | undefined }): null {
    latest = useThrottledLatestValue(value, 50)
    return null
  }

  function render(value: string | undefined): void {
    act(() => {
      renderer = create(createElement(Harness, { value }))
    })
  }

  function update(value: string | undefined): void {
    act(() => renderer?.update(createElement(Harness, { value })))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    latest = undefined
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  it('emits the first frame immediately', () => {
    render('a')
    expect(latest).toBe('a')
  })

  it('holds rapid updates but eventually emits the latest value', () => {
    render('a')
    update('ab')
    update('abc')
    expect(latest).toBe('a')
    act(() => vi.advanceTimersByTime(50))
    expect(latest).toBe('abc')
  })

  it('clears immediately and drops the trailing emit when the value goes undefined', () => {
    render('a')
    update('ab')
    expect(latest).toBe('a')
    update(undefined)
    expect(latest).toBeUndefined()
    act(() => vi.advanceTimersByTime(50))
    expect(latest).toBeUndefined()
  })
})

// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../store'
import { useLazyModalMounts } from './use-lazy-modal-mounts'

const initialState = useAppStore.getState()

describe('useLazyModalMounts', () => {
  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('keeps AddRepoDialog mounted while a background clone is still running', async () => {
    useAppStore.setState({ activeModal: 'add-repo' })
    const { result, rerender } = renderHook(() => useLazyModalMounts())
    expect(result.current.shouldMountAddRepoDialog).toBe(true)

    act(() => {
      useAppStore.setState({ activeModal: 'none', isAddRepoCloneInFlight: true })
    })
    rerender()
    // Why: closing the dialog while a clone is in flight must not tear the
    // component down, or the promise that adds the finished repo is lost.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.current.shouldMountAddRepoDialog).toBe(true)
  })

  it('unmounts AddRepoDialog once the background clone finishes', async () => {
    useAppStore.setState({ activeModal: 'add-repo', isAddRepoCloneInFlight: true })
    const { result, rerender } = renderHook(() => useLazyModalMounts())

    act(() => {
      useAppStore.setState({ activeModal: 'none' })
    })
    rerender()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.current.shouldMountAddRepoDialog).toBe(true)

    act(() => {
      useAppStore.setState({ isAddRepoCloneInFlight: false })
    })
    rerender()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.current.shouldMountAddRepoDialog).toBe(false)
  })

  it('unmounts AddRepoDialog on close as before when no clone is running', async () => {
    useAppStore.setState({ activeModal: 'add-repo' })
    const { result, rerender } = renderHook(() => useLazyModalMounts())

    act(() => {
      useAppStore.setState({ activeModal: 'none' })
    })
    rerender()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.current.shouldMountAddRepoDialog).toBe(false)
  })
})

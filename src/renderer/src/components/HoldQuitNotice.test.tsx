// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Toaster } from 'sonner'
import { HoldQuitHint, HoldQuitNotice } from './HoldQuitNotice'
import type { HoldQuitNotice as Notice } from '../../../shared/mac-hold-quit'

let emit: (notice: Notice) => void = () => {}
const originalApi = window.api
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.api = originalApi
})

function mount(): void {
  Object.assign(window, {
    api: {
      ui: {
        onHoldQuitNotice: (callback: typeof emit) => {
          emit = callback
          return vi.fn()
        }
      }
    }
  })
  render(
    <>
      <Toaster />
      <HoldQuitNotice />
    </>
  )
}

it('shows a zero progress track immediately and resets on release while leaving the reason readable', async () => {
  mount()
  await act(async () => emit({ phase: 'starting' }))
  expect((await screen.findByRole('status')).textContent).toBe(
    'Agents are still working. Hold ⌘Q to quit.'
  )
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
  await act(async () => emit({ phase: 'holding' }))
  expect(await screen.findByRole('progressbar')).toBeDefined()
  await act(async () => emit({ phase: 'released' }))
  await waitFor(() =>
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
  )
  expect(screen.getByRole('status').textContent).toContain('Agents are still working.')
})

it('offers an explicit menu route if the physical hold cannot be checked', async () => {
  mount()
  await act(async () => emit({ phase: 'unavailable' }))
  await screen.findByText('Hold-to-quit is unavailable. Use the application menu to quit.')
  expect(screen.queryByRole('progressbar')).toBeNull()
})

it('fills only after the native watcher starts and cancels the visual timer on release', () => {
  let now = 100
  let tick: FrameRequestCallback = () => {}
  const cancel = vi.spyOn(window, 'cancelAnimationFrame')
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    tick = callback
    return 7
  })
  const view = render(<HoldQuitHint phase="starting" />)
  expect(frame).not.toHaveBeenCalled()
  view.rerender(<HoldQuitHint key="holding" phase="holding" />)
  now = 600
  act(() => tick(now))
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
  view.rerender(<HoldQuitHint key="released" phase="released" />)
  expect(cancel).toHaveBeenCalledWith(7)
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
  frame.mockRestore()
  clock.mockRestore()
  cancel.mockRestore()
})

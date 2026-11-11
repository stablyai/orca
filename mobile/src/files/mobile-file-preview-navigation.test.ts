import { describe, expect, it, vi } from 'vitest'
import { navigateToMobileFilePreview } from './mobile-file-preview-navigation'

describe('mobile-file-preview-navigation', () => {
  it('pushes the file route before closing the embedded explorer on scheduler delivery', () => {
    const events: string[] = []
    const push = vi.fn(() => events.push('push'))
    const scheduleClose = vi.fn((_callback: () => void, _delay: number) => {
      events.push('schedule')
    })
    const params = {
      hostId: 'host-1',
      worktreeId: 'wt-1',
      relativePath: 'assets/a #b?c%25 d\\logo.png',
      name: 'logo.png',
      worktreeName: 'Orca'
    }

    navigateToMobileFilePreview({ push }, params, {
      embedded: true,
      scheduleClose,
      onRequestClose: () => events.push('close')
    })

    expect(push).toHaveBeenCalledExactlyOnceWith({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params
    })
    expect(events).toEqual(['push', 'schedule'])
    expect(scheduleClose).toHaveBeenCalledWith(expect.any(Function), 0)
    scheduleClose.mock.calls[0]?.[0]()
    expect(events).toEqual(['push', 'schedule', 'close'])
  })
})

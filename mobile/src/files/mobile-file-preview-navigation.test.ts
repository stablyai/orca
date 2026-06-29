import { describe, expect, it, vi } from 'vitest'
import {
  canPreviewMobileFileRow,
  navigateToMobileFilePreview
} from './mobile-file-preview-navigation'

describe('mobile-file-preview-navigation', () => {
  it('navigates preview interactions to the encoded Expo target without files.open', () => {
    const push = vi.fn()
    const relativePath = 'assets/a #b?c%25 d\\logo.png'

    navigateToMobileFilePreview(
      { push },
      {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath,
        name: 'logo.png',
        worktreeName: 'Orca'
      }
    )

    expect(push).toHaveBeenCalledWith({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath,
        name: 'logo.png',
        worktreeName: 'Orca'
      }
    })
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('defers embedded close until after route push', () => {
    const events: string[] = []
    const scheduleClose = vi.fn((callback: () => void) => {
      events.push('schedule')
      callback()
    })

    navigateToMobileFilePreview(
      {
        push: () => events.push('push')
      },
      {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath: 'README.md'
      },
      {
        embedded: true,
        scheduleClose,
        onRequestClose: () => events.push('close')
      }
    )

    expect(events).toEqual(['push', 'schedule', 'close'])
    expect(scheduleClose).toHaveBeenCalledWith(expect.any(Function), 0)
  })

  it('keeps non-image binary rows disabled while previewing text and raster images', () => {
    expect(canPreviewMobileFileRow({ kind: 'text', relativePath: 'src/app.ts' })).toBe(true)
    expect(canPreviewMobileFileRow({ kind: 'binary', relativePath: 'assets/logo.webp' })).toBe(true)
    expect(canPreviewMobileFileRow({ kind: 'binary', relativePath: 'archive.zip' })).toBe(false)
  })
})

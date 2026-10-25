import { describe, expect, it, vi } from 'vitest'
import {
  canPreviewMobileFileRow,
  navigateToMobileFilePreview
} from './mobile-file-preview-navigation'

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

  it.each(['mp4', 'MOV', 'm4v', 'webm', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus'])(
    'opens %s files from the explorer',
    (extension) => {
      expect(
        canPreviewMobileFileRow({ kind: 'binary', relativePath: `media/demo.${extension}` })
      ).toBe(true)
    }
  )

  it('keeps non-image binary rows disabled while previewing text and raster images', () => {
    expect(canPreviewMobileFileRow({ kind: 'text', relativePath: 'src/app.ts' })).toBe(true)
    expect(canPreviewMobileFileRow({ kind: 'binary', relativePath: 'assets/logo.webp' })).toBe(true)
    expect(canPreviewMobileFileRow({ kind: 'binary', relativePath: 'archive.zip' })).toBe(false)
  })
})

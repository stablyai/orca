import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { ActionSheetAction } from '../components/ActionSheetModal'

const captured = vi.hoisted(() => ({
  actionsByTitle: new Map<string, ActionSheetAction[]>(),
  messageByTitle: new Map<string, string | undefined>(),
  clipboardWriteText: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
}))

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('lucide-react-native', () => ({
  Copy: 'Icon',
  Globe: 'Icon'
}))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: captured.clipboardWriteText })
}))
vi.mock('../platform/haptics', () => ({
  triggerSelection: () => {},
  triggerSuccess: () => {},
  triggerError: () => {}
}))
vi.mock('../components/ActionSheetModal', () => ({
  ActionSheetModal: ({
    title,
    message,
    actions
  }: {
    title: string
    message?: string
    actions: ActionSheetAction[]
  }) => {
    captured.actionsByTitle.set(title, actions)
    captured.messageByTitle.set(title, message)
    return null
  }
}))

import {
  displayTitleFromTerminalUrl,
  MobileTerminalUrlTapSheet
} from './MobileTerminalUrlTapSheet'

describe('MobileTerminalUrlTapSheet', () => {
  it('derives the sheet heading from the URL host with a fallback for non-standard URLs', () => {
    expect(displayTitleFromTerminalUrl('https://github.com/stablyai/orca/pull/32980')).toBe(
      'github.com'
    )
    expect(displayTitleFromTerminalUrl('http://localhost:3000/session/123')).toBe('localhost:3000')
    expect(displayTitleFromTerminalUrl('https://example.com/build:1234/log')).toBe('example.com')
    expect(
      displayTitleFromTerminalUrl('https://attacker.example/path/@trusted.example/')
    ).toBe('attacker.example')
    expect(displayTitleFromTerminalUrl('not a url')).toBe('URL Link')
  })

  it('offers Open URL and Copy URL and invokes onOpen when Open URL is pressed', async () => {
    captured.actionsByTitle.clear()
    captured.messageByTitle.clear()
    const setPendingTerminalUrlTap = vi.fn()
    const showToast = vi.fn()
    const onOpen = vi.fn()
    const url = 'https://github.com/stablyai/orca/pull/32980'

    await act(async () => {
      create(
        createElement(MobileTerminalUrlTapSheet, {
          controller: {
            pendingTerminalUrlTap: {
              title: 'github.com',
              url,
              onOpen
            },
            setPendingTerminalUrlTap,
            showToast
          }
        })
      )
    })

    const actions = captured.actionsByTitle.get('github.com') ?? []
    expect(actions.map((action) => action.label)).toEqual(['Open URL', 'Copy URL'])
    expect(captured.messageByTitle.get('github.com')).toBe(url)

    actions.find((action) => action.label === 'Open URL')?.onPress()
    expect(setPendingTerminalUrlTap).toHaveBeenCalledWith(null)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('copies the URL and shows a toast when Copy URL is pressed', async () => {
    captured.actionsByTitle.clear()
    captured.clipboardWriteText.mockClear()
    const setPendingTerminalUrlTap = vi.fn()
    const showToast = vi.fn()
    const url = 'https://docs.stably.ai/guide'

    await act(async () => {
      create(
        createElement(MobileTerminalUrlTapSheet, {
          controller: {
            pendingTerminalUrlTap: {
              title: 'docs.stably.ai',
              url,
              onOpen: () => {}
            },
            setPendingTerminalUrlTap,
            showToast
          }
        })
      )
    })

    const copyUrlAction = captured.actionsByTitle
      .get('docs.stably.ai')
      ?.find((action) => action.label === 'Copy URL')
    expect(copyUrlAction).toBeDefined()
    copyUrlAction?.onPress()
    await Promise.resolve()

    expect(setPendingTerminalUrlTap).toHaveBeenCalledWith(null)
    expect(captured.clipboardWriteText).toHaveBeenCalledWith(url)
    expect(showToast).toHaveBeenCalledWith('URL copied')
  })

  it('reports an error toast when copying the URL fails', async () => {
    captured.actionsByTitle.clear()
    captured.clipboardWriteText.mockImplementationOnce(() => Promise.reject(new Error('denied')))
    const setPendingTerminalUrlTap = vi.fn()
    const showToast = vi.fn()

    await act(async () => {
      create(
        createElement(MobileTerminalUrlTapSheet, {
          controller: {
            pendingTerminalUrlTap: {
              title: 'docs.stably.ai',
              url: 'https://docs.stably.ai/guide',
              onOpen: () => {}
            },
            setPendingTerminalUrlTap,
            showToast
          }
        })
      )
    })

    captured.actionsByTitle
      .get('docs.stably.ai')
      ?.find((action) => action.label === 'Copy URL')
      ?.onPress()
    await Promise.resolve()
    await Promise.resolve()

    expect(setPendingTerminalUrlTap).toHaveBeenCalledWith(null)
    expect(showToast).toHaveBeenCalledWith("Couldn't copy URL", 1500)
  })
})

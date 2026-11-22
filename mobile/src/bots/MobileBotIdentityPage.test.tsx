import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ ImageUp: 'Icon' }))
vi.mock('../components/nav-bar/SheetHeader', () => ({ SheetHeader: () => null }))
vi.mock('../components/list/ListGroup', () => ({
  ListGroup: 'ListGroup',
  ListRow: () => null,
  SectionHeader: 'SectionHeader'
}))
vi.mock('../components/composer-input/TextField', () => ({ TextField: 'TextField' }))
vi.mock('../settings/settings-screen-frame', () => ({ SettingsNote: 'SettingsNote' }))
vi.mock('./MobileBotAvatar', () => ({ MobileBotAvatar: 'MobileBotAvatar' }))
vi.mock('../platform/media-picking/media-picker', () => ({
  useMediaPicker: () => ({ pickImage: async () => ({ uri: 'picked' }) })
}))
vi.mock('./bot-avatar-photo', () => ({
  BotAvatarPhotoError: class extends Error {},
  botAvatarPngFromPhoto: async () => 'NEWPNG'
}))

import { ListRow } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { MobileBotIdentityPage } from './MobileBotIdentityPage'
import type { SheetBot } from './bot-sheet-operations'

const bot: SheetBot = {
  id: 'b1',
  name: 'Pal',
  folderWorkspaceId: 'b1-home',
  avatar: 'upload:old',
  avatarColor: null,
  paused: false,
  agent: 'claude',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null
}

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('MobileBotIdentityPage', () => {
  // An upload overwrites the bot's only copy of its picture, so Cancel could not put it back.
  it('uploads a picked photo only on Done', async () => {
    const onCancel = vi.fn()
    const onUpload = vi.fn(async () => true)
    await act(async () => {
      renderer = create(
        createElement(MobileBotIdentityPage, {
          bot,
          avatar: { kind: 'image', uri: 'old' },
          takesColor: true,
          disabled: false,
          banner: null,
          onCancel,
          onSave: async () => true,
          onUpload,
          showToast: () => {}
        })
      )
    })
    const page = renderer?.root
    if (!page) {
      throw new Error('identity page did not mount')
    }
    await act(async () => page.findByType(ListRow).props.onPress())
    expect(onUpload).not.toHaveBeenCalled()

    await act(async () => page.findByType(SheetHeader).props.trailing?.onPress())
    expect(onUpload).toHaveBeenCalledWith('NEWPNG')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

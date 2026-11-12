import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposerAttachButton } from './MobileNativeChatComposerAttachButton'
import {
  findAllByHostType,
  findByHostType
} from '../../../test-support/react-test-renderer-host-nodes'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, flatten: (style: unknown) => style }
}))
vi.mock('lucide-react-native', () => ({
  AtSign: 'AtSign',
  Image: 'Image',
  Package: 'Package',
  Paperclip: 'Paperclip',
  Plus: 'Plus',
  Terminal: 'Terminal'
}))
vi.mock('../../../theme/mobile-theme', () => ({ colors: {} }))
vi.mock('../../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../../../i18n/mobile-i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('../../../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('../../../components/composer-input/composer-input-styles', () => ({
  COMPOSER_CONTROL_HIT_SLOP: 0,
  composerInputStyles: { controlButton: {}, pressed: {} }
}))

const menu = { openFileMenu: vi.fn(), openSlashMenu: vi.fn(), skillCount: 0 }

function draw(props: { onAttachFiles?: () => void; structured?: boolean }): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(
      createElement(MobileNativeChatComposerAttachButton, {
        onAttachImage: props.structured === true ? undefined : photos,
        onAttachFiles: props.onAttachFiles,
        structured: props.structured === true,
        isAttaching: false,
        disabled: false,
        menu
      })
    )
  })
  return renderer
}
const photos = vi.fn()

describe('MobileNativeChatComposerAttachButton in a terminal-backed chat', () => {
  it('lists Photos and Files, and no structured-only entries, when files can be attached', () => {
    const renderer = draw({ onAttachFiles: vi.fn() })
    act(() => findByHostType(renderer.root, 'Pressable').props.onPress())
    const sheet = findAllByHostType(renderer.root, 'ActionSheetModal')[0]!
    expect(sheet.props.visible).toBe(true)
    expect(sheet.props.actions.map((action: { id: string }) => action.id)).toEqual([
      'photos',
      'files'
    ])
  })

  it('opens the photo library at once when the host cannot store files', () => {
    photos.mockClear()
    const renderer = draw({})
    act(() => findByHostType(renderer.root, 'Pressable').props.onPress())
    expect(photos).toHaveBeenCalledTimes(1)
    expect(findAllByHostType(renderer.root, 'ActionSheetModal')).toHaveLength(0)
  })
})

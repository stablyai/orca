import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MobileBrowserJavaScriptDialog } from './MobileBrowserJavaScriptDialog'

vi.mock('react-native', () => ({ Pressable: 'Pressable', Text: 'Text', View: 'View' }))
vi.mock('../../components/composer-input/FieldTextInput', () => ({
  FieldTextInput: 'FieldTextInput'
}))
vi.mock('./mobile-browser-pane-styles', () => ({ mobileBrowserPaneStyles: {} }))
vi.mock('../../theme/mobile-theme', () => ({ spacing: { xl: 24 } }))
vi.mock('../../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'light' }))
vi.mock('../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))

describe('MobileBrowserJavaScriptDialog', () => {
  it('starts a prompt at the page default and sends the typed answer', () => {
    const sendDialogCommand = vi.fn(async () => {})
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        createElement(MobileBrowserJavaScriptDialog, {
          dialog: {
            occurrence: 1,
            dialogType: 'prompt',
            message: 'What is your name?',
            defaultPromptText: 'Ada',
            origin: 'https://example.com'
          },
          keyboardLift: 0,
          sendDialogCommand
        })
      )
    })
    const field = renderer.root.find((node) => String(node.type) === 'FieldTextInput')
    expect(field.props.value).toBe('Ada')
    act(() => field.props.onChangeText('Grace'))
    act(() =>
      renderer.root
        .findAll((node) => String(node.type) === 'Pressable')
        .at(-1)!
        .props.onPress()
    )
    expect(sendDialogCommand).toHaveBeenCalledWith('browser.dialogAccept', 'Grace')
    act(() => renderer.unmount())
  })
})

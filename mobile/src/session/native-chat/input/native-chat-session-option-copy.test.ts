import { expect, it, vi } from 'vitest'
import { nativeChatSessionChoiceLabel } from '../../../../../src/shared/native-chat/input/native-chat-session-option-labels'
import { sayMobileNativeChatSessionOption } from './native-chat-session-option-copy'

vi.mock('../../../i18n/mobile-i18n', () => ({
  translate: (key: string, fallback: string) =>
    key.endsWith('.ultracode') ? 'Ultracode traduit' : fallback
}))

it('localizes the compound effort on the phone through its option label surface', () => {
  expect(
    nativeChatSessionChoiceLabel(
      { value: 'ultracode', label: 'ultracode' },
      sayMobileNativeChatSessionOption,
      'effort'
    )
  ).toBe('Ultracode traduit')
})

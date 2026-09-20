import type { AccessoryKeyDescriptor } from '../components/keyboard-accessory/accessory-key-descriptor'

export type BrowserPointerModifier = 'cmd' | 'ctrl' | 'alt' | 'shift'

const BROWSER_POINTER_MODIFIERS: { id: BrowserPointerModifier; label: string }[] = [
  { id: 'cmd', label: 'Cmd' },
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'alt', label: 'Alt' },
  { id: 'shift', label: 'Shift' }
]

const BROWSER_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape'] as const

function specialKeyLabel(key: string): string {
  return key === 'Backspace' ? '⌫' : key === 'Escape' ? 'Esc' : key
}

type BuildArgs = {
  selectedModifiers: BrowserPointerModifier[]
  onToggleModifier: (modifier: BrowserPointerModifier) => void
  onKeypress: (key: string) => void
}

export function buildBrowserKeyboardDescriptors({
  selectedModifiers,
  onToggleModifier,
  onKeypress
}: BuildArgs): AccessoryKeyDescriptor[] {
  const modifierDescriptors: AccessoryKeyDescriptor[] = BROWSER_POINTER_MODIFIERS.map(
    (modifier) => ({
      id: `modifier-${modifier.id}`,
      label: modifier.label,
      active: selectedModifiers.includes(modifier.id),
      onPress: () => onToggleModifier(modifier.id),
      accessibilityLabel: `${modifier.label} click modifier`
    })
  )
  const keyDescriptors: AccessoryKeyDescriptor[] = BROWSER_KEYS.map((key) => ({
    id: `key-${key}`,
    label: specialKeyLabel(key),
    onPress: () => onKeypress(key),
    accessibilityLabel: key
  }))
  return [...modifierDescriptors, ...keyDescriptors]
}

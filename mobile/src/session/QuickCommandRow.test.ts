import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import { QuickCommandRow } from './QuickCommandRow'

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(() => Promise.resolve(true)) }))
const haptics = vi.hoisted(() => ({ notificationAsync: vi.fn(() => Promise.resolve()) }))

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  Copy: 'Copy',
  Pencil: 'Pencil',
  Play: 'Play',
  Trash2: 'Trash2'
}))

vi.mock('expo-clipboard', () => clipboard)

vi.mock('expo-haptics', () => ({
  ...haptics,
  performAndroidHapticsAsync: vi.fn(() => Promise.resolve()),
  AndroidHaptics: { Reject: 'reject' },
  NotificationFeedbackType: { Error: 'error', Success: 'success' }
}))

vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))

const COMMAND: TerminalQuickCommand = {
  id: 'qc-1',
  label: 'Run tests',
  command: 'run the tests',
  appendEnter: true
}

// Require visible error feedback and haptics when clipboard writes reject; a failed write must never show Copied.
describe('the quick-command row when the pasteboard refuses the text', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    clipboard.setStringAsync.mockReset()
    haptics.notificationAsync.mockReset()
    haptics.notificationAsync.mockImplementation(() => Promise.resolve())
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  // Find by every copy-state label so feedback transitions cannot make the control disappear from assertions.
  const COPY_LABELS = new Set([
    `Copy ${COMMAND.label}`,
    'Copied',
    "Couldn't copy",
    'Nothing to copy'
  ])

  function copyButton() {
    const button = renderer!.root
      .findAll((node) => node.props.accessibilityRole === 'button')
      .find((node) => COPY_LABELS.has(String(node.props.accessibilityLabel)))
    if (button === undefined) {
      throw new Error('the row has no copy button')
    }
    return button
  }

  function rowProps() {
    return {
      command: COMMAND,
      first: true,
      onLaunch: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      disabled: false
    }
  }

  async function mountAndCopy(): Promise<void> {
    await act(async () => {
      renderer = create(createElement(QuickCommandRow, rowProps()))
    })
    await act(async () => {
      copyButton().props.onPress()
    })
  }

  it('says it could not copy and buzzes the error', async () => {
    clipboard.setStringAsync.mockResolvedValue(false)
    await mountAndCopy()
    expect(copyButton().props.accessibilityLabel).toBe("Couldn't copy")
    expect(haptics.notificationAsync).toHaveBeenCalledWith('error')
  })

  it('emits nothing at all when the row is gone before the refusal arrives', async () => {
    // Unmount before rejection; feedback without a surviving row would buzz with no explanation.
    let refuse: ((error: Error) => void) | undefined
    clipboard.setStringAsync.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject
        })
    )
    await act(async () => {
      renderer = create(createElement(QuickCommandRow, rowProps()))
    })
    await act(async () => {
      copyButton().props.onPress()
    })
    act(() => renderer?.unmount())
    renderer = null
    await act(async () => {
      refuse?.(new Error('pasteboard refused'))
    })
    expect(haptics.notificationAsync).not.toHaveBeenCalled()
  })

  it('shows the copied label and no error buzz when the write lands', async () => {
    clipboard.setStringAsync.mockResolvedValue(true)
    await mountAndCopy()
    expect(copyButton().props.accessibilityLabel).toBe('Copied')
    expect(haptics.notificationAsync).not.toHaveBeenCalled()
  })
})

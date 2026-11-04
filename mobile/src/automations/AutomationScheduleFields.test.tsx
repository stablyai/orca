import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateMobileUiLocale } from '../i18n/mobile-i18n'
import { AutomationChoice, AutomationField } from './AutomationControls'
import { AutomationScheduleFields } from './AutomationScheduleFields'
import { automationDraftPatch, newAutomationDraft, type AutomationDraft } from './automation-draft'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  StyleSheet: { create: <T,>(styles: T) => styles },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))
vi.mock(
  '../platform/text-input-font-size',
  async () => await import('../platform/text-input-font-size.web')
)
vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))

let tree: ReactTestRenderer | null = null
beforeEach(async () => {
  await activateMobileUiLocale('en')
  const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat
  ) {
    return { ...resolvedOptions.call(this), timeZone: 'Asia/Shanghai' }
  })
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 2))
})
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  vi.restoreAllMocks()
})

async function mount() {
  const original = {
    ...newAutomationDraft(),
    rrule: '30 9 * * *',
    timezone: 'America/New_York'
  }
  let current = original
  function Harness({ version = 0 }: { version?: number }) {
    const [draft, setDraft] = useState<AutomationDraft>(original)
    current = draft
    return createElement(AutomationScheduleFields, {
      key: version,
      draft,
      change: (patch) => setDraft((previous) => ({ ...previous, ...patch })),
      disabled: false
    })
  }
  await act(async () => {
    tree = create(createElement(Harness))
  })
  return {
    draft: () => current,
    patch: () => automationDraftPatch(current, original),
    async select(cadence: string) {
      const choice = tree!.root
        .findAllByType(AutomationChoice)
        .find((node) => node.props.label === 'Cadence')!
      await act(async () => choice.props.onSelect(cadence))
    },
    async edit(label: string, value: string) {
      const field = tree!.root
        .findAllByType(AutomationField)
        .find((node) => node.props.label === label)!
      await act(async () => field.props.onChange(value))
    },
    async revisitScheduleStep() {
      await act(async () => tree!.update(createElement(Harness, { version: 1 })))
    }
  }
}

describe('mobile one-time cadence time zones', () => {
  it.each(['hourly', 'daily', 'weekdays', 'weekly', 'custom'])(
    'keeps the recurring time zone after visiting once and selecting %s',
    async (cadence) => {
      const editor = await mount()
      await editor.select('once')
      await editor.select(cadence)

      expect(editor.draft().timezone).toBe('America/New_York')
      expect(editor.patch()).not.toHaveProperty('timezone')
    }
  )

  it('keeps the most recently edited recurring time zone across repeated switches', async () => {
    const editor = await mount()
    await editor.edit('Time zone', 'Europe/London')
    await editor.select('once')
    await editor.select('daily')
    expect(editor.patch().timezone).toBe('Europe/London')

    await editor.edit('Time zone', 'Pacific/Auckland')
    await editor.select('once')
    await editor.select('weekly')
    expect(editor.patch().timezone).toBe('Pacific/Auckland')
  })

  it('keeps the recurring time zone when returning to the schedule step', async () => {
    const editor = await mount()
    await editor.select('once')
    await editor.revisitScheduleStep()
    await editor.select('daily')

    expect(editor.draft().timezone).toBe('America/New_York')
    expect(editor.patch()).not.toHaveProperty('timezone')
  })

  it('still saves the phone time zone when choosing and editing a one-time run', async () => {
    const editor = await mount()
    await editor.select('once')
    await editor.edit('Date (YYYY-MM-DD)', '2099-11-05')
    await editor.edit('Time (HH:MM, 24 hour)', '17:45')

    expect(editor.draft().rrule).toMatch(/^ONCE=/)
    expect(editor.patch().timezone).toBe('Asia/Shanghai')
    expect(editor.patch()).not.toHaveProperty('recurringTimezone')
  })
})

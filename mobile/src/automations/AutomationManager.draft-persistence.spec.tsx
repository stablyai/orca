import { act, type ReactTestInstance } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { publishPageDeviceStore } from '../mobile-web-shell/bridge/page-device-store'
import { AutomationField } from './AutomationControls'
import { resetAutomationEditorDraftsForTests } from './automation-editor-draft-row'

export function registerAutomationDraftPersistenceTests({
  root,
  press,
  mount,
  unmount
}: {
  root: () => ReactTestInstance
  press: (label: string) => Promise<void>
  mount: () => Promise<unknown>
  unmount: () => void
}): void {
  it('brings unsaved edits back after the page reloads, and forgets them once discarded', async () => {
    // The shell's draft table outlives the page; nothing else does.
    const table = new Map<string, string>()
    publishPageDeviceStore({
      available: () => true,
      read: async (_table, keys) => ({
        status: 'ok',
        values: keys.map((key) => table.get(key) ?? null)
      }),
      write: async (_table, ops) => {
        for (const op of ops) {
          if (op.value === null) {
            table.delete(op.key)
          } else {
            table.set(op.key, op.value)
          }
        }
        return { written: true }
      }
    })
    const field = (label: string) =>
      root()
        .findAllByType(AutomationField)
        .find((node) => node.props.label === label)!
    async function reload(): Promise<void> {
      unmount()
      resetAutomationEditorDraftsForTests()
      await mount()
      await press('New automation')
    }
    try {
      await mount()
      await press('New automation')
      vi.useFakeTimers()
      await act(async () => {
        field('Name').props.onChange('Nightly digest')
        field('Instructions').props.onChange('Summarize merged PRs')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      vi.useRealTimers()
      await reload()
      expect(field('Name').props.value).toBe('Nightly digest')
      expect(field('Instructions').props.value).toBe('Summarize merged PRs')

      await press('Cancel')
      const prompt = root().find(
        (node) => String(node.type) === 'ConfirmModal' && node.props.visible === true
      )
      await act(async () => prompt.props.onConfirm())
      await reload()
      expect(field('Name').props.value).toBe('')
      expect(table.size).toBe(0)
    } finally {
      vi.useRealTimers()
      publishPageDeviceStore(null)
    }
  })
}

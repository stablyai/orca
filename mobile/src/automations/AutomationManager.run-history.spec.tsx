import { act, type ReactTestInstance } from 'react-test-renderer'
import { expect, it } from 'vitest'
import { AutomationEditor } from './AutomationEditor'
import { AutomationRunList } from './AutomationRunList'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import type { automationClient } from './automation-test-fixtures'

export function registerAutomationRunHistoryTests({
  mount,
  root,
  press
}: {
  mount: () => Promise<ReturnType<typeof automationClient>>
  root: () => ReactTestInstance
  press: (label: string) => Promise<void>
}): void {
  it('observes history only while a history consumer is visible', async () => {
    const port = await mount()
    const historyReads = () =>
      port.send.mock.calls.filter(([method]) => method === 'automation.runs')
    const refresh = async () => {
      await act(async () => {
        port.event({ type: 'automationsChanged' })
      })
    }
    const tab = async (value: 'automations' | 'runs') => {
      await act(async () => {
        root().findByType(MobileSegmentedControl).props.onSelect(value)
      })
    }
    const catalogReads = port.send.mock.calls.filter(
      ([method]) => method === 'automation.list'
    ).length
    expect(historyReads()).toHaveLength(0)
    await refresh()
    expect(
      port.send.mock.calls.filter(([method]) => method === 'automation.list').length
    ).toBeGreaterThan(catalogReads)
    expect(historyReads()).toHaveLength(0)
    await press('New automation')
    expect(root().findByType(AutomationEditor)).toBeTruthy()
    await refresh()
    expect(historyReads()).toHaveLength(0)

    await tab('runs')
    expect(historyReads()).toHaveLength(1)
    const original = root().findByType(AutomationRunList).props.history.runs[0]
    await tab('automations')
    await refresh()
    expect(historyReads()).toHaveLength(1)
    await press('New automation')
    await refresh()
    expect(historyReads()).toHaveLength(1)
    await tab('runs')
    expect(historyReads()).toHaveLength(2)
    expect(root().findByType(AutomationRunList).props.history.runs[0]).toEqual(original)
  })
}

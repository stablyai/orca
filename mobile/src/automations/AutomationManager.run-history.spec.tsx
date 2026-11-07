import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { AutomationEditor } from './AutomationEditor'
import { AutomationRunList } from './AutomationRunList'
import { AutomationRunDetails } from './AutomationRunDetails'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { automationClient, savedRun } from './automation-test-fixtures'

export function registerAutomationRunHistoryTests({
  mount,
  root,
  press,
  setTree
}: {
  mount: () => Promise<ReturnType<typeof automationClient>>
  root: () => ReactTestInstance
  press: (label: string) => Promise<void>
  setTree: (tree: ReactTestRenderer) => void
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

  it('retries a failed full-row read when history re-reads the row', async () => {
    const preview = {
      ...savedRun(),
      outputSnapshot: { content: 'START', capturedAt: 1700000000003, truncated: true }
    }
    let reachable = false
    const port = automationClient(() => {
      if (!reachable) {
        throw new Error('offline')
      }
      return {
        run: {
          ...preview,
          outputSnapshot: { content: 'START END', capturedAt: 1700000000003, truncated: false }
        }
      }
    })
    const details = (run: typeof preview) =>
      createElement(AutomationRunDetails, {
        run,
        client: port.client,
        hostId: 'paired',
        connected: true,
        history: {
          runs: [run],
          selected: run,
          unavailable: false,
          cursor: null,
          loading: false,
          error: null,
          loadMore: vi.fn(),
          reload: vi.fn(),
          scope: null
        },
        onBack: vi.fn()
      })
    const shows = (content: string) =>
      root()
        .findAll((node) => String(node.type) === 'Text')
        .some((node) => JSON.stringify(node.props.children) === JSON.stringify(content))
    const tree = create(details(preview))
    setTree(tree)
    await act(async () => {})
    expect(shows('START')).toBe(true)
    reachable = true
    await act(async () => {
      tree.update(details({ ...preview }))
    })
    expect(shows('START END')).toBe(true)
  })
}

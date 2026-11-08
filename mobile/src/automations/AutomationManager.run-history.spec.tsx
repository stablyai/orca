import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { AutomationRunDetails } from './AutomationRunDetails'
import { automationClient, savedRun } from './automation-test-fixtures'

export function registerAutomationRunHistoryTests({
  root,
  setTree
}: {
  root: () => ReactTestInstance
  setTree: (tree: ReactTestRenderer) => void
}): void {
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

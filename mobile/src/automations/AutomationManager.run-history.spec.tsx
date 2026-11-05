import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it } from 'vitest'
import { AutomationEditor } from './AutomationEditor'
import { AutomationRunList } from './AutomationRunList'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { automationClient, savedAutomation, savedRun } from './automation-test-fixtures'
import { AutomationManager } from './AutomationManager'
import { AutomationList } from './AutomationList'
import { AutomationRunDetails } from './AutomationRunDetails'
import { AutomationChoice } from './AutomationControls'
import { activateMobileUiLocale } from '../i18n/mobile-i18n'

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
  const text = (node = root()) =>
    node.findAll((child) => String(child.type) === 'Text').map((child) => child.props.children)
  const runRows = () =>
    root()
      .findByType(AutomationRunList)
      .findAll((node) => String(node.type) === 'Pressable')
  const rowTitles = () => runRows().map((node) => node.props.accessibilityLabel.split(',')[0])
  const openAutomation = async () => {
    await act(async () => {
      const list = root().findByType(AutomationList)
      list.props.onOpen(list.props.rows[0])
    })
  }
  async function mountRows(runs: unknown[], manual = savedRun('manual')) {
    const automation = { ...savedAutomation(), surface: 'terminal' }
    const port = automationClient((method) => {
      if (method === 'status.get') {
        return { capabilities: [] }
      }
      if (method === 'automation.list') {
        return {
          automations: [automation],
          items: [
            {
              automationId: automation.id,
              selector: { kind: 'self' },
              usageSummary: { lastRunStatus: 'dispatched', lastRunAt: 1700000000000 }
            }
          ]
        }
      }
      if (method === 'automation.runs') {
        return { runs, nextCursor: null }
      }
      if (method === 'automation.runNow') {
        runs = [manual, ...runs]
        return { run: manual }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    await act(async () => {
      setTree(create(createElement(AutomationManager, { client: port.client, hostId: 'desktop' })))
    })
    return port
  }

  it('keeps decoded delivery history readable in All but outside In progress after reload', async () => {
    const rows = [
      {
        ...savedRun('terminal'),
        title: 'Terminal delivery',
        status: 'dispatched',
        sessionKind: 'terminal'
      },
      { ...savedRun('chat'), title: 'Chat delivery', status: 'dispatched', sessionKind: 'chat' },
      { ...savedRun('pending'), title: 'Pending work', status: 'pending' },
      {
        ...savedRun('starting'),
        title: 'Starting work',
        status: 'dispatching',
        sessionKind: 'terminal'
      },
      { ...savedRun('completed'), title: 'Exact completion', sessionKind: 'chat' },
      ...[undefined, null, { future: true }, 7, 'future-kind'].map((kind, index) => ({
        ...savedRun(`kind-${index}`),
        title: `Unknown kind ${index}`,
        status: 'dispatched',
        ...(kind === undefined ? {} : { sessionKind: kind })
      })),
      {
        ...savedRun('future'),
        title: 'Future result',
        status: 'future-status',
        sessionKind: 'chat'
      },
      { ...savedRun('unreadable'), status: 42 }
    ]
    const port = await mountRows(rows)
    await act(async () => root().findByType(MobileSegmentedControl).props.onSelect('runs'))
    const allTitles = [
      'Terminal delivery',
      'Chat delivery',
      'Pending work',
      'Starting work',
      'Exact completion',
      'Unknown kind 0',
      'Unknown kind 1',
      'Unknown kind 2',
      'Unknown kind 3',
      'Unknown kind 4',
      'Future result'
    ]
    expect(rowTitles()).toEqual(allTitles)
    expect(text()).toContain('Unknown result')
    expect(runRows().filter((row) => text(row).includes('Sent'))).toHaveLength(1)
    const outcome = () =>
      root()
        .findAllByType(AutomationChoice)
        .find((node) => node.props.label === 'Outcome')!
    await act(async () => outcome().props.onSelect('active'))
    expect(rowTitles()).toEqual(['Chat delivery', 'Pending work', 'Starting work'])
    const reads = port.send.mock.calls.filter(([method]) => method === 'automation.runs').length
    await act(async () => {
      port.event({ type: 'automationsChanged' })
    })
    expect(port.send.mock.calls.filter(([method]) => method === 'automation.runs')).toHaveLength(
      reads + 1
    )
    expect(rowTitles()).toEqual(['Chat delivery', 'Pending work', 'Starting work'])
    await act(async () => outcome().props.onSelect('all'))
    expect(rowTitles()).toEqual(allTitles)
    await act(async () => runRows()[0]!.props.onPress())
    expect(root().findByType(AutomationRunDetails).props.run.status).toBe('dispatched')
    expect(text()).toContain('Terminal delivery')
    expect(text()).toContain('Dispatched')
    expect(text()).not.toContain('Completed')
  })

  it('shows historical Chat Sent in French recent, accessible history, details and manual result', async () => {
    await activateMobileUiLocale('fr')
    try {
      const chat = {
        ...savedRun('chat'),
        title: 'Historical Chat',
        status: 'dispatched',
        sessionKind: 'chat'
      }
      const manual = { ...chat, id: 'manual', title: 'Returned Chat', trigger: 'manual' }
      const port = await mountRows([chat], manual)
      expect(
        text().some(
          (value) => typeof value === 'string' && value.startsWith('Dernière : Transmise')
        )
      ).toBe(true)
      expect(text()).not.toContain('Envoyé')
      await openAutomation()
      expect(root().findByType(AutomationRunList).props.recent).toBe(true)
      expect(text(runRows()[0]!)).toContain('Envoyé')
      expect(runRows()[0]!.props.accessibilityLabel).toContain('Historical Chat, Envoyé,')
      await act(async () => runRows()[0]!.props.onPress())
      expect(text()).toContain('Envoyé')
      expect(text()).not.toContain('Terminé')
      await press('Toutes les exécutions')
      expect(runRows()[0]!.props.accessibilityLabel).toContain('Historical Chat, Envoyé,')
      await act(async () => root().findByType(MobileSegmentedControl).props.onSelect('automations'))
      await openAutomation()
      await press('Exécuter maintenant')
      expect(root().findByType(AutomationRunDetails).props.run.id).toBe('manual')
      expect(text()).toContain('Returned Chat')
      expect(text()).toContain('Envoyé')
      expect(
        port.send.mock.calls.filter(([method]) => method === 'automation.runNow')
      ).toHaveLength(1)
    } finally {
      await act(async () => {
        await activateMobileUiLocale('en')
      })
    }
  })

  it.each([
    ['pending', 'Pending'],
    ['dispatching', 'Starting'],
    ['completed', 'Completed']
  ])(
    'keeps the actual returned Chat %s result distinct from accepted delivery',
    async (status, label) => {
      await mountRows([], { ...savedRun('manual'), status, sessionKind: 'chat' })
      await openAutomation()
      await press('Run now')
      expect(root().findByType(AutomationRunDetails).props.run.status).toBe(status)
      expect(text()).toContain(label)
      expect(text()).not.toContain('Sent')
    }
  )

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

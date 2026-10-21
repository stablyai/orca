import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationManager } from './AutomationManager'
import { AutomationButton, AutomationChoice, AutomationField } from './AutomationControls'
import { AutomationRunList } from './AutomationRunList'
import { AutomationRunDetails } from './AutomationRunDetails'
import type * as AutomationInventoryModule from './automation-target-inventory'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import {
  automationClient,
  automationTargets,
  savedAutomation,
  savedRun
} from './automation-test-fixtures'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  TextInput: 'TextInput',
  StyleSheet: { create: <T,>(styles: T) => styles },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))
vi.mock('lucide-react-native', () => ({
  CalendarClock: 'CalendarClock',
  ChevronRight: 'ChevronRight'
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: 'ConfirmModal' }))
vi.mock('../session/use-open-mobile-session', () => ({ useOpenMobileSession: () => () => {} }))
vi.mock('./automation-target-inventory', async (original) => ({
  ...(await original<typeof AutomationInventoryModule>()),
  loadAutomationTargets: async () => automationTargets(),
  loadAutomationAgents: async () => [{ agent: 'codex', label: 'Codex' }]
}))

let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})
function root() {
  if (!tree) {
    throw new Error('Not mounted')
  }
  return tree.root
}
async function press(label: string) {
  const button = root()
    .findAllByType(AutomationButton)
    .find((node) => node.props.label === label)
  if (!button || button.props.disabled) {
    throw new Error(`Button unavailable: ${label}`)
  }
  await act(async () => {
    button.props.onPress()
  })
}
function text(node: ReactTestInstance): string {
  return JSON.stringify(node.props.children)
}
async function mount() {
  let automation = savedAutomation()
  const oldRun = savedRun()
  const manualRun = { ...savedRun('manual-run'), status: 'dispatched', trigger: 'manual' }
  let runs = [oldRun]
  const port = automationClient((method, params) => {
    if (method === 'status.get') {
      return { capabilities: [] }
    }
    if (method === 'automation.list') {
      return {
        automations: [automation],
        items: [
          {
            automationId: automation.id,
            selector: { kind: 'self' }
          }
        ]
      }
    }
    if (method === 'automation.runs') {
      return { runs }
    }
    if (method === 'automation.runNow') {
      runs = [manualRun, oldRun]
      return { run: manualRun }
    }
    if (method === 'automation.show') {
      return { automation }
    }
    if (method === 'automation.update') {
      if (
        params &&
        typeof params === 'object' &&
        'updates' in params &&
        params.updates &&
        typeof params.updates === 'object'
      ) {
        automation = { ...automation, ...params.updates }
      }
      return { automation }
    }
    if (method === 'automation.create') {
      return { automation: { ...automation, id: 'created', name: 'Daily review', enabled: true } }
    }
    throw new Error(`Unexpected request: ${method}`)
  })
  await act(async () => {
    tree = create(createElement(AutomationManager, { client: port.client, hostId: 'desktop' }))
  })
  return port
}

describe('mobile automation navigation and setup', () => {
  it('opens exact historical and returned manual runs with explicit paths back', async () => {
    const port = await mount()
    await act(async () => {
      root().findByType(MobileSegmentedControl).props.onSelect('runs')
    })
    const runList = root().findByType(AutomationRunList)
    const runRow = runList
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => node.props.accessibilityLabel?.startsWith('Review changes,'))
    if (!runRow) {
      throw new Error('History row missing')
    }
    await act(async () => {
      runRow.props.onPress()
    })
    expect(root().findByType(AutomationRunDetails).props.run.id).toBe('run-old')
    expect(
      root()
        .findAll((node) => String(node.type) === 'Text')
        .some((node) => text(node).includes('Output for run-old'))
    ).toBe(true)
    await press('All runs')
    expect(root().findByType(AutomationRunList)).toBeTruthy()
    expect(
      port.send.mock.calls
        .filter(([method]) => method === 'automation.runs')
        .every(([, params]) => JSON.stringify(params) === '{"limit":30}')
    ).toBe(true)
    await act(async () => {
      root().findByType(MobileSegmentedControl).props.onSelect('automations')
    })
    const entry = root()
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) =>
        node
          .findAll((child) => String(child.type) === 'Text')
          .some((child) => child.props.children === 'Review changes')
      )
    if (!entry) {
      throw new Error('Automation entry missing')
    }
    await act(async () => {
      entry.props.onPress()
    })
    await press('Run now')
    expect(root().findByType(AutomationRunDetails).props.run.id).toBe('manual-run')
    expect(port.send).toHaveBeenCalledWith(
      'automation.runNow',
      {
        id: 'automation-1',
        expectedOwner: { selector: { kind: 'self' } }
      },
      { failWhenDisconnected: true }
    )
    await press('All runs')
    await act(async () => {
      root().findByType(MobileSegmentedControl).props.onSelect('automations')
    })
  })
  it('creates through Task, Schedule and Review without an enabled switch', async () => {
    const port = await mount()
    await press('New automation')
    const field = (label: string) =>
      root()
        .findAllByType(AutomationField)
        .find((node) => node.props.label === label)!
    await act(async () => {
      field('Name').props.onChange('Daily review')
      field('Instructions').props.onChange('Review changes')
    })
    expect(root().findAll((node) => String(node.type) === 'Switch')).toHaveLength(0)
    await press('Continue')
    expect(
      root()
        .findAllByType(AutomationChoice)
        .some((node) => node.props.label === 'Cadence')
    ).toBe(true)
    await press('Continue')
    await press('Create automation')
    const sent = port.send.mock.calls.find(([method]) => method === 'automation.create')
    expect(sent?.[1]).toMatchObject({ enabled: true, name: 'Daily review', repo: 'id:repo-1' })
    expect(root().findAll((node) => String(node.type) === 'Switch')).toHaveLength(1)
    await press('All automations')
    expect(
      root()
        .findAllByType(AutomationButton)
        .some((node) => node.props.label === 'New automation')
    ).toBe(true)
  })
})

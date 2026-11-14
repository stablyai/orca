import { registerAutomationRunHistoryTests } from './AutomationManager.run-history.spec'

import { act, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, vi } from 'vitest'
import { resetAutomationEditorDraftsForTests } from './automation-editor-draft-row'

import type * as AutomationInventoryModule from './automation-target-inventory'

import { automationTargets } from './automation-test-fixtures'

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
vi.mock(
  '../platform/text-input/text-input-font-size',
  async () => await import('../platform/text-input/text-input-font-size.web')
)
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  CalendarClock: 'CalendarClock',
  ChevronRight: 'ChevronRight'
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))
vi.mock('../components/bottom-drawer/BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: 'ConfirmModal' }))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ push: inventory.push })
}))
const inventory = vi.hoisted(() => ({ targets: vi.fn(), agents: vi.fn(), push: vi.fn() }))
vi.mock('./automation-target-inventory', async (original) => ({
  ...(await original<typeof AutomationInventoryModule>()),
  loadAutomationTargets: (...args: unknown[]) => inventory.targets(...args),
  loadAutomationAgents: (...args: unknown[]) => inventory.agents(...args)
}))

beforeEach(() => {
  inventory.targets.mockReset().mockImplementation(async () => automationTargets())
  inventory.agents.mockReset().mockResolvedValue([{ agent: 'codex', label: 'Codex' }])
  inventory.push.mockClear()
})
let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  // Unsaved edits outlive the editor for the page's life; each test is a fresh page.
  resetAutomationEditorDraftsForTests()
})
function setTree(value: ReactTestRenderer): void {
  tree = value
}
function root() {
  if (!tree) {
    throw new Error('Not mounted')
  }
  return tree.root
}

describe('mobile automation navigation and setup', () => {
  registerAutomationRunHistoryTests({ root, setTree })
})

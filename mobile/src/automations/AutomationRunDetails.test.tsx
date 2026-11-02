import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateMobileUiLocale } from '../i18n/mobile-i18n'
import { runSchema } from './automation-reply-schema'
import { AutomationRunDetails } from './AutomationRunDetails'
import { AutomationButton } from './AutomationControls'
import { automationClient, deferred, savedRun } from './automation-test-fixtures'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  StyleSheet: { create: <T,>(styles: T) => styles }
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ push: inventory.push })
}))
const inventory = vi.hoisted(() => ({ push: vi.fn() }))
let tree: ReactTestRenderer | null = null
afterEach(async () => {
  act(() => tree?.unmount())
  tree = null
  inventory.push.mockClear()
  await activateMobileUiLocale('en')
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

describe('exact automation run pane navigation', () => {
  it.each(['success', 'error'] as const)(
    'ignores a superseded pane verification %s while the new authority is opening',
    async (late) => {
      const leaf = '11111111-1111-4111-8111-111111111111'
      const run = {
        ...savedRun(),
        workspaceId: 'folder:saved',
        terminalPaneKey: `original:${leaf}`,
        terminalPtyId: 'pty'
      }
      const a = deferred<unknown>()
      const b = deferred<unknown>()
      const first = automationClient(() => a.promise)
      const second = automationClient(() => b.promise)
      const history = {
        runs: [run],
        selected: run,
        unavailable: false,
        cursor: null,
        loading: false,
        error: null,
        loadMore: vi.fn(),
        reload: vi.fn()
      }
      const props = {
        run,
        client: first.client,
        hostId: 'A',
        connected: true,
        history,
        onBack: vi.fn()
      }
      await act(async () => {
        tree = create(createElement(AutomationRunDetails, props))
      })
      await press('Open agent')
      await act(async () => {
        tree?.update(
          createElement(AutomationRunDetails, { ...props, client: second.client, hostId: 'B' })
        )
      })
      await press('Open agent')
      const reply = {
        terminals: [
          {
            worktreeId: run.workspaceId,
            tabId: 'original',
            leafId: leaf,
            ptyId: 'pty',
            connected: true
          }
        ]
      }
      await act(async () => {
        if (late === 'error') {
          a.reject(new Error('late A'))
        } else {
          a.resolve(reply)
        }
      })
      expect(inventory.push).not.toHaveBeenCalled()
      expect(
        root()
          .findAllByType(AutomationButton)
          .find((node) => node.props.label === 'Open agent')!.props.disabled
      ).toBe(true)
      expect(
        root().findAll(
          (node) => String(node.type) === 'Text' && node.props.accessibilityRole === 'alert'
        )
      ).toHaveLength(0)
      await act(async () => {
        b.resolve(reply)
      })
      expect(inventory.push).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          params: expect.objectContaining({ hostId: 'B', paneKey: run.terminalPaneKey })
        })
      )
    }
  )
})

it('localizes the selected run failure in both the reason and the output fallback', async () => {
  await activateMobileUiLocale('fr')
  const run = runSchema.parse({
    ...savedRun(),
    error: 'Automation run target is no longer available.',
    errorCode: 'targetUnavailable',
    outputSnapshot: null
  })
  await act(async () => {
    tree = create(
      createElement(AutomationRunDetails, {
        run: savedRun(),
        client: null,
        hostId: 'A',
        connected: false,
        history: {
          runs: [run],
          selected: run,
          unavailable: false,
          cursor: null,
          loading: false,
          error: null,
          loadMore: vi.fn(),
          reload: vi.fn()
        },
        onBack: vi.fn()
      })
    )
  })
  const text = () =>
    root()
      .findAll((node) => String(node.type) === 'Text')
      .map((node) => node.props.children)
  expect(
    text().filter(
      (value) => value === 'La cible d’exécution de l’automatisation n’est plus disponible.'
    )
  ).toHaveLength(2)
  expect(text()).not.toContain(run.error)
  await act(async () => {
    await activateMobileUiLocale('en')
  })
  expect(text().filter((value) => value === run.error)).toHaveLength(2)
})

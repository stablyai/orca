// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MobilePrTabSheets } from './MobilePrTabSheets'
import type { MobilePrTab, PrTabSheetRequest } from './use-mobile-pr-tab'

type Field = { value: string; onChangeText: (value: string) => void }
const io = vi.hoisted(() => ({
  load: vi.fn(),
  fields: new Map<string, Field>()
}))
vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  View: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Text: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  ActivityIndicator: () => <span role="progressbar" />,
  Pressable: ({ children }: React.PropsWithChildren) => <div>{children}</div>
}))
vi.mock('lucide-react-native', () => ({
  ChevronsUpDown: () => null,
  GitMerge: () => null,
  Sparkles: () => null
}))
// The drawer finishes its hide at once, so a closed sheet unmounts as it does on the phone.
vi.mock('../bottom-drawer/mounted-bottom-drawer', async () => {
  const { useLayoutEffect } = await import('react')
  return {
    MountedBottomDrawer: ({
      visible,
      children,
      onHidden
    }: React.PropsWithChildren<{ visible: boolean; onHidden: () => void }>) => {
      useLayoutEffect(() => {
        if (!visible) {
          onHidden()
        }
      }, [visible, onHidden])
      return <div>{children}</div>
    }
  }
})
vi.mock('../composer-input/FieldTextInput', () => ({
  FieldTextInput: (props: Field & { accessibilityLabel?: string }) => {
    io.fields.set(props.accessibilityLabel ?? '', props)
    return null
  }
}))
vi.mock('../nav-bar/SheetHeader', () => ({ SheetHeader: () => null }))
vi.mock('../SheetPrimaryButton', () => ({ SheetPrimaryButton: () => null }))
vi.mock('../list/ListGroup', () => ({ ListGroup: () => null, ListRow: () => null }))
vi.mock('../MobileSwitch', () => ({ MobileSwitch: () => null }))
vi.mock('../ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('./PrReviewersSheet', () => ({ PrReviewersSheet: () => null }))
vi.mock('./PrBasePicker', () => ({ PrBasePicker: () => null }))
vi.mock('../../source-control/MobileCommitFailurePanel', () => ({
  MobileCommitFailurePanel: () => null
}))
vi.mock('../../source-control/use-mobile-commit-failure-recovery', () => ({
  useMobileCommitFailureRecovery: () => ({})
}))
vi.mock('../../source-control/mobile-pr-create-draft', () => ({
  loadMobilePrCreateDraft: io.load,
  generateMobilePrFields: vi.fn(),
  cancelMobilePrFields: vi.fn()
}))
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('../../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  io.fields.clear()
  io.load.mockReset()
})

function seed(title: string) {
  return { prefill: { provider: 'github' }, title, body: '', base: 'main' }
}

function render(gitBranch: string, sheetRequest: PrTabSheetRequest | null) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: carries every MobilePrTab member the sheets and Create read.
  const tab = {
    client: {},
    worktreeId: 'wt-1',
    gitBranch,
    gitStatus: null,
    commitsAhead: 2,
    creatingPr: false,
    setCreatingPr: () => {},
    state: { kind: 'none' },
    confirm: null,
    sheetRequest,
    sheetInScope: () => true,
    closeSheet: () => {},
    onSheetAfterClose: () => {}
  } as unknown as MobilePrTab
  act(() => root!.render(<MobilePrTabSheets tab={tab} />))
}

function createRequest(id: number): PrTabSheetRequest {
  return {
    kind: 'createPr',
    scope: { client: null, worktreeId: 'wt-1', branch: 'feature/a', resource: null },
    id
  }
}

async function settle() {
  await act(async () => {})
}

it('reopens Create PR on the same branch with the typed title, and seeds another branch from its commits', async () => {
  root = createRoot(document.createElement('div'))
  io.load.mockImplementation(async (_client: unknown, _wt: string, input: { branch: string }) =>
    seed(input.branch === 'feature/a' ? 'Seeded from a' : 'Seeded from b')
  )
  render('feature/a', createRequest(1))
  await settle()
  act(() => io.fields.get('Title')!.onChangeText('My typed title'))

  render('feature/a', null)
  io.fields.clear()
  render('feature/a', createRequest(2))
  await settle()

  expect(io.fields.get('Title')!.value).toBe('My typed title')

  render('feature/a', null)
  io.fields.clear()
  render('feature/b', createRequest(3))
  await settle()

  expect(io.fields.get('Title')!.value).toBe('Seeded from b')
})

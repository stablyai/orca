import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const hosts = vi.hoisted(() => {
  const make = (name: string) => {
    const Host = (props: { children?: ReactNode }): ReactNode => props.children ?? null
    Host.displayName = name
    return Host
  }
  return {
    View: make('View'),
    Text: make('Text'),
    Pressable: make('Pressable'),
    Field: make('FieldTextInput'),
    Button: make('SheetPrimaryButton')
  }
})
vi.mock('react-native', () => ({
  View: hosts.View,
  Text: hosts.Text,
  Pressable: hosts.Pressable,
  ActivityIndicator: hosts.View,
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFillObject: {} },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios }
}))
vi.mock('lucide-react-native', () => ({ ChevronsUpDown: hosts.View, Sparkles: hosts.View }))
vi.mock('../../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'light' }))
vi.mock('../nav-bar/SheetHeader', () => ({ SheetHeader: hosts.View }))
vi.mock('../SheetPrimaryButton', () => ({ SheetPrimaryButton: hosts.Button }))
vi.mock('../list/ListGroup', () => ({ ListGroup: hosts.View, ListRow: hosts.View }))
vi.mock('../MobileSwitch', () => ({ MobileSwitch: hosts.View }))
vi.mock('./PrBasePicker', () => ({ PrBasePicker: hosts.View }))
vi.mock('../composer-input/FieldTextInput', () => ({ FieldTextInput: hosts.Field }))
vi.mock('../../source-control/MobileCommitFailurePanel', () => ({
  MobileCommitFailurePanel: hosts.View
}))
vi.mock('../../source-control/use-mobile-commit-failure-recovery', () => ({
  useMobileCommitFailureRecovery: () => null
}))
const host = vi.hoisted(() => ({
  seed: vi.fn(),
  create: vi.fn()
}))
vi.mock('../../source-control/mobile-pr-create-draft', () => ({
  loadMobilePrCreateDraft: host.seed,
  generateMobilePrFields: vi.fn(),
  cancelMobilePrFields: vi.fn(async () => {})
}))
vi.mock('../../source-control/mobile-hosted-review-create-intent-runner', () => ({
  runMobileHostedReviewCreateIntent: host.create,
  isMobileHostedReviewCommitFailure: () => false
}))

import { publishPageDeviceStore } from '../../mobile-web-shell/bridge/page-device-store'
import { resetKeptDraftsForTests } from '../../drafts/use-kept-draft'
import { createFakeRpcClient } from '../../mobile-web-shell/bridge-host-test-fakes'
import { PrCreateSheet } from './PrCreateSheet'
import type { MobilePrTab } from './use-mobile-pr-tab'
import { mountFixture } from '../../test-support/rpc-recording/recorder-fixture-shape'

// The shell's draft table outlives the page; nothing else does.
const table = new Map<string, string>()
let renderer: ReactTestRenderer | null = null

// The sheet reads only these fields of the PR tab.
const tab = mountFixture<MobilePrTab>({
  client: createFakeRpcClient(),
  hostId: 'host-1',
  worktreeId: 'repo::/work/feature',
  gitBranch: 'feature/login',
  gitStatus: null,
  commitsAhead: null,
  connState: 'connected',
  workspaceLabel: 'feature',
  creatingPr: false,
  setCreatingPr: () => {},
  closeSheet: () => {},
  closeSheetThen: () => {}
})

async function open(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(PrCreateSheet, { tab }))
    await vi.advanceTimersByTimeAsync(0)
  })
}

function titleField(): ReactTestInstance | undefined {
  return renderer?.root.findAllByType(hosts.Field)[0]
}

async function typeTitle(title: string): Promise<void> {
  act(() => titleField()?.props.onChangeText(title))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
}

// A kill: the page and its memory go, the store stays.
function kill(): void {
  act(() => renderer?.unmount())
  renderer = null
  resetKeptDraftsForTests()
}

beforeEach(() => {
  vi.useFakeTimers()
  host.seed.mockResolvedValue({
    prefill: { provider: 'github', base: 'main', title: '', body: '' },
    title: 'Seed from commits',
    body: '',
    base: 'main'
  })
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
})

afterEach(() => {
  kill()
  table.clear()
  publishPageDeviceStore(null)
  host.seed.mockReset()
  host.create.mockReset()
  vi.useRealTimers()
})

it('brings typed fields back after the app is killed instead of the commit seed', async () => {
  await open()
  expect(titleField()?.props.value).toBe('Seed from commits')
  await typeTitle('Fix the login race')
  kill()

  await open()
  expect(titleField()?.props.value).toBe('Fix the login race')
})

it('keeps nothing for the next Create once a Create lands after its sheet closed', async () => {
  let land: (outcome: unknown) => void = () => {}
  host.create.mockReturnValue(new Promise((resolve) => (land = resolve)))
  await open()
  await typeTitle('Fix the login race')
  act(() => renderer?.root.findByType(hosts.Button).props.onPress())
  // A branch or client change closes the sheet while the Create is still running.
  act(() => renderer?.unmount())
  await act(async () => {
    land({ ok: true, url: 'https://example.test/pr/1', prefill: { provider: 'github' } })
    await vi.advanceTimersByTimeAsync(1000)
  })
  kill()

  await open()
  expect(titleField()?.props.value).toBe('Seed from commits')
})

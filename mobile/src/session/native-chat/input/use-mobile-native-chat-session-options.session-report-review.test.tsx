import { randomUUID } from 'node:crypto'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeChatModelPillLabel } from '../../../../../src/shared/native-chat/input/native-chat-session-option-labels'
import { sayMobileNativeChatSessionOption } from './native-chat-session-option-copy'
import {
  useMobileNativeChatSessionOptions,
  type MobileNativeChatSessionOptionsController
} from './use-mobile-native-chat-session-options'

type HookArgs = Parameters<typeof useMobileNativeChatSessionOptions>[0]

let renderer: ReactTestRenderer | null = null
let api: MobileNativeChatSessionOptionsController | null = null
let hookArgs: HookArgs

function Probe(): null {
  api = useMobileNativeChatSessionOptions(hookArgs)
  return null
}

function mount(args: HookArgs): void {
  hookArgs = args
  act(() => {
    renderer = create(createElement(Probe))
  })
}

function update(overrides: Partial<HookArgs>): void {
  hookArgs = { ...hookArgs, ...overrides }
  act(() => {
    renderer!.update(createElement(Probe))
  })
}

function unmount(): void {
  act(() => renderer?.unmount())
  renderer = null
}

const base = (scopeKey: string): HookArgs => ({
  agent: 'claude',
  scopeKey,
  reportedModel: 'claude-opus-5',
  dispatchCommand: vi.fn(async () => 'accepted' as const),
  onAgentPicker: vi.fn()
})

const report = (model: string, effort: string | null) => ({
  model,
  effort,
  usedTokens: 1000,
  windowTokens: 1000000,
  compactions: 0
})

const option = (id: string) => api!.snapshot.find((descriptor) => descriptor.id === id)

afterEach(() => {
  unmount()
  api = null
})

it('keeps a phone pick when the chat is reopened and its status loads again', async () => {
  const scopeKey = `session-report-${randomUUID()}`
  mount({ ...base(scopeKey), sessionReport: null })
  update({ sessionReport: report('claude-opus-5-5', 'high') })
  await act(async () => {
    await api!.setOption('effort', 'low')
  })
  unmount()
  mount({ ...base(scopeKey), sessionReport: null })
  update({ sessionReport: report('claude-opus-5-5', 'high') })
  expect(option('effort')?.kind).toMatchObject({ currentValue: 'low' })
})

it('shows a model picked on the phone rather than the last reply', async () => {
  mount({
    ...base(`session-report-${randomUUID()}`),
    sessionReport: report('claude-opus-5-5', 'high')
  })
  await act(async () => {
    await api!.setOption('model', 'sonnet')
  })
  expect(
    nativeChatModelPillLabel(option('model')!, sayMobileNativeChatSessionOption)
  ).not.toContain('Opus')
})

it('names the exact model version on the pill', () => {
  mount({
    ...base(`session-report-${randomUUID()}`),
    sessionReport: report('claude-opus-5-5', 'high')
  })
  expect(nativeChatModelPillLabel(option('model')!, sayMobileNativeChatSessionOption)).toBe(
    'Opus 5.5'
  )
})

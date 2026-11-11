import { randomUUID } from 'node:crypto'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
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

function mount(overrides: Partial<HookArgs>): void {
  hookArgs = {
    agent: 'claude',
    scopeKey: `session-report-${randomUUID()}`,
    reportedModel: null,
    dispatchCommand: vi.fn(async () => 'accepted' as const),
    onAgentPicker: vi.fn(),
    ...overrides
  }
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

const report = (model: string, effort: string | null) => ({
  model,
  effort,
  usedTokens: 1000,
  windowTokens: 1000000,
  compactions: 0
})

const option = (id: string) => api!.snapshot.find((descriptor) => descriptor.id === id)

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  api = null
})

it('shows the model and effort of the last reply', () => {
  mount({ sessionReport: report('claude-opus-5-5', 'high') })
  expect(option('model')).toMatchObject({
    valueSource: 'reported',
    kind: { currentValue: 'opus' }
  })
  expect(option('effort')?.kind).toMatchObject({ currentValue: 'high' })
})

it('prefers the session file over the hook model', () => {
  mount({
    reportedModel: 'claude-sonnet-5',
    sessionReport: report('claude-opus-5-5', null)
  })
  expect(option('model')?.kind).toMatchObject({ currentValue: 'opus' })
})

it('keeps using the hook model when there is no report', () => {
  mount({ reportedModel: 'claude-sonnet-5', sessionReport: null })
  expect(option('model')?.kind).toMatchObject({ currentValue: 'sonnet' })
})

it('names a model missing from the catalog', () => {
  mount({ sessionReport: report('claude-future-9', null) })
  expect(option('model')?.kind).toMatchObject({ currentValue: 'claude-future-9' })
})

it('keeps a phone pick until the next reply reports something new', async () => {
  const sessionReport = report('claude-opus-5-5', 'high')
  mount({ sessionReport })
  await act(async () => {
    await api!.setOption('effort', 'low')
  })
  update({ sessionReport: { ...sessionReport } })
  expect(option('effort')?.kind).toMatchObject({ currentValue: 'low' })
  update({ sessionReport: report('claude-opus-5-5', 'xhigh') })
  expect(option('effort')?.kind).toMatchObject({ currentValue: 'xhigh' })
})

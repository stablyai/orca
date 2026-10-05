// The phone picker applies the same report rule as the desktop: a field model is new evidence
// only when its report identity changes; a status/field source switch never undoes a pick.
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import {
  conversationAddressKey,
  type TerminalConversationIdentity
} from '../../../src/shared/terminal-conversation-identity'
import { selectMobileTerminalConversation } from './mobile-native-chat-eligibility'
import {
  clearMobileSessionOptionRecordsForTests,
  useMobileNativeChatSessionOptions,
  type MobileNativeChatSessionOptionsController
} from './use-mobile-native-chat-session-options'

type HookArgs = Parameters<typeof useMobileNativeChatSessionOptions>[0]

const S = { key: 'session_id' as const, id: 'S', transcriptPath: '/r/S.jsonl' }
const MODELS = ['old/P', 'new/Q', 'user/R', 'next/Q2', 'other/P2', 'rollback/V'].map((id) => ({
  id,
  label: id,
  options: []
}))

function field(
  model: string,
  overrides: Partial<TerminalConversationIdentity> = {}
): TerminalConversationIdentity {
  return {
    agentType: 'omp',
    providerSession: S,
    model,
    modelSwitchCommand: 'orca-model',
    capturedAt: 100,
    source: 'live',
    ...overrides
  }
}

type Frame = { status?: string; field?: TerminalConversationIdentity }

/** What the phone's controller hands the picker for one frame of the active tab. */
function argsFor(
  frame: Frame
): Pick<HookArgs, 'reportedModel' | 'modelSwitchCommand' | 'modelReport'> {
  const agentStatus: AgentStatusEntry | undefined = frame.status
    ? {
        state: 'done',
        prompt: '',
        updatedAt: 1,
        stateStartedAt: 1,
        stateHistory: [],
        paneKey: 'tab:leaf',
        agentType: 'omp',
        providerSession: S,
        model: frame.status,
        modelSwitchCommand: 'orca-model'
      }
    : undefined
  const selection = selectMobileTerminalConversation(
    {
      type: 'terminal',
      agentStatus,
      ...(frame.field !== undefined ? { conversationIdentity: frame.field } : {}),
      ...(!frame.status && frame.field ? { conversationOfferedWithoutStatus: true as const } : {})
    },
    'omp'
  )
  return {
    reportedModel: selection.model,
    modelSwitchCommand: selection.modelSwitchCommand ?? undefined,
    modelReport: {
      conversationKey: conversationAddressKey(selection.address),
      modelSource: selection.modelSource,
      fieldReportKey: selection.fieldReportKey
    }
  }
}

describe('phone picker model from the conversation field', () => {
  let renderer: ReactTestRenderer | null = null
  let api: MobileNativeChatSessionOptionsController | null = null
  let hookArgs: HookArgs
  const dispatchCommand = vi.fn<HookArgs['dispatchCommand']>()

  function Probe(): null {
    api = useMobileNativeChatSessionOptions(hookArgs)
    return null
  }

  const deliver = (frame: Frame): void => {
    hookArgs = { ...hookArgs, ...argsFor(frame) }
    act(() => {
      if (renderer) {
        renderer.update(createElement(Probe))
      } else {
        renderer = create(createElement(Probe))
      }
    })
  }

  const selected = (): string | undefined => {
    const kind = api?.snapshot.find((descriptor) => descriptor.id === 'model')?.kind
    return kind?.type === 'select' ? kind.currentValue : undefined
  }

  const pick = async (model: string): Promise<void> => {
    await act(async () => {
      await api!.setOption('model', model)
    })
    expect(selected()).toBe(model)
  }

  beforeEach(() => {
    clearMobileSessionOptionRecordsForTests()
    dispatchCommand.mockReset()
    dispatchCommand.mockResolvedValue('accepted')
    hookArgs = {
      agent: 'omp',
      scopeKey: 'host\0worktree\0tab',
      reportedModel: null,
      discoveredModels: MODELS,
      dispatchCommand
    }
  })
  afterEach(() => {
    act(() => {
      renderer?.unmount()
    })
    renderer = null
    api = null
  })

  it('keeps a pick across a no-evidence frame when the unchanged field returns', async () => {
    deliver({ status: 'new/Q', field: field('old/P') })
    expect(selected()).toBe('new/Q')
    await pick('user/R')
    deliver({})
    deliver({ field: field('old/P') })
    expect(selected()).toBe('user/R')
  })

  it('applies a field model that changed while it was unusable', async () => {
    deliver({ status: 'new/Q', field: field('old/P') })
    await pick('user/R')
    deliver({})
    deliver({ field: field('other/P2') })
    expect(selected()).toBe('other/P2')
  })

  it('keeps a pick when the field goes absent and the same report returns', async () => {
    deliver({ field: field('old/P') })
    await pick('user/R')
    deliver({})
    deliver({ field: field('old/P') })
    expect(selected()).toBe('user/R')
  })

  it('keeps a pick when a status goes away and comes back over an unchanged field', async () => {
    deliver({ status: 'new/Q', field: field('old/P') })
    expect(selected()).toBe('new/Q')
    await pick('user/R')
    deliver({ field: field('old/P') })
    expect(selected()).toBe('user/R')
    deliver({ status: 'new/Q', field: field('old/P') })
    expect(selected()).toBe('user/R')
    expect(dispatchCommand).toHaveBeenCalledTimes(1)
  })

  it('takes a genuinely new status report after a pick', async () => {
    deliver({ status: 'new/Q', field: field('old/P') })
    await pick('user/R')
    deliver({ status: 'next/Q2', field: field('old/P') })
    expect(selected()).toBe('next/Q2')
  })

  it('reseeds when the pane moves to another conversation', async () => {
    deliver({ field: field('old/P') })
    await pick('user/R')
    deliver({ field: field('other/P2', { providerSession: { key: 'session_id', id: 'T' } }) })
    expect(selected()).toBe('other/P2')
  })

  it('seeds a cold picker from the field, then keeps a later status choice', () => {
    deliver({ field: field('old/P') })
    expect(selected()).toBe('old/P')
    deliver({ status: 'new/Q', field: field('old/P') })
    expect(selected()).toBe('new/Q')
    deliver({ field: field('old/P') })
    expect(selected()).toBe('new/Q')
  })

  it('identifies a field report by its whole tuple, not its clock alone', async () => {
    deliver({ field: field('old/P', { capturedAt: 100 }) })
    deliver({ field: field('new/Q', { capturedAt: 100 }) })
    expect(selected()).toBe('new/Q')
    deliver({ field: field('old/P', { capturedAt: 101 }) })
    await pick('user/R')
    deliver({ field: field('old/P', { capturedAt: 101 }) })
    expect(selected()).toBe('user/R')
    deliver({ field: field('rollback/V', { capturedAt: 90 }) })
    expect(selected()).toBe('rollback/V')
  })

  it('keeps today: a re-delivered status-only report never undoes a pick', async () => {
    deliver({ status: 'new/Q' })
    await pick('user/R')
    deliver({ status: 'new/Q' })
    expect(selected()).toBe('user/R')
  })
})

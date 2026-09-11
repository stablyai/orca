/**
 * A `--on` worker runs on another machine, so this process's own capability list says nothing
 * about whether that machine can host a structured session. The remote refusal fires first today;
 * these pin the evidence the decision is built from, which is what survives that refusal moving.
 */

import { describe, expect, it, vi } from 'vitest'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import type * as LaunchRouteModule from '../../../../shared/structured-native-chat-launch-route'

const mocks = vi.hoisted(() => ({ resolveSupport: vi.fn() }))

vi.mock('../../../../shared/structured-native-chat-launch-route', async (importOriginal) => {
  const original = await importOriginal<typeof LaunchRouteModule>()
  mocks.resolveSupport.mockImplementation(original.resolveStructuredNativeChatSupport)
  return { ...original, resolveStructuredNativeChatSupport: mocks.resolveSupport }
})

import { decideWorkerStartMode } from './orchestration-worker-start-mode'

const STRUCTURED_DEFAULT = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true
}

const decide = (params: { agent: string; on?: string }) =>
  decideWorkerStartMode({ params, settings: STRUCTURED_DEFAULT })

describe('worker start capability evidence', () => {
  it('leaves a remote target unestablished rather than answering with this host', () => {
    const receipt = decide({ agent: 'claude', on: 'server-1' })
    expect(mocks.resolveSupport).toHaveBeenCalledWith(
      expect.objectContaining({ executionHostId: 'runtime:server-1', hostCapabilities: null })
    )
    expect(receipt).toMatchObject({ mode: 'terminal', reason: 'remote_execution_host' })
  })

  it('still answers for a local worker from this host', () => {
    expect(decide({ agent: 'claude' })).toMatchObject({ mode: 'structured' })
    expect(mocks.resolveSupport).toHaveBeenCalledWith(
      expect.objectContaining({ executionHostId: 'local', hostCapabilities: RUNTIME_CAPABILITIES })
    )
  })

  it.each([
    ['host-policy-disabled', 'host_structured_chat_disabled', 'structured chat turned off'],
    ['host-disconnected', 'host_disconnected', 'not connected to the execution host']
  ] as const)('turns %s into a %s receipt', (blocker, reason, detail) => {
    mocks.resolveSupport.mockReturnValueOnce({ supported: false, blocker })
    const receipt = decide({ agent: 'claude', on: 'server-1' })
    expect(receipt).toMatchObject({ mode: 'terminal', preferred: 'structured', reason })
    expect(receipt.detail).toContain(detail)
  })
})

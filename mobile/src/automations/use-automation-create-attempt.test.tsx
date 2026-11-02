import { act } from 'react-test-renderer'
import { hookMount } from '../test-support/rpc-recording/hook-mount'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAutomationCreateAttempt } from './use-automation-create-attempt'
import { automationClient, automationTargets, savedAutomation } from './automation-test-fixtures'
import { automationSetupKey } from './automation-target-inventory'
import { newAutomationDraft } from './automation-draft'
import { AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../src/shared/automation-runtime-capabilities'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'

const mounts = new Set<ReturnType<typeof hookMount>>()
afterEach(() => {
  for (const mount of mounts) {
    mount.unmount()
  }
  mounts.clear()
})

const current = () => true
function renderAttempt() {
  let value!: ReturnType<typeof useAutomationCreateAttempt>
  const mount = hookMount(() => {
    value = useAutomationCreateAttempt([], true, () => {}, current)
  })
  mounts.add(mount)
  mount.mount()
  return {
    result: {
      get current() {
        return value
      }
    },
    unmount: mount.unmount
  }
}
const draft = () => ({
  ...newAutomationDraft(savedAutomation()),
  setupId: automationSetupKey(automationTargets().setups[0]!),
  workspaceMode: 'existing' as const,
  workspaceId: 'workspace-1',
  extraAgentArgs: ''
})

describe('mobile automation create refusal recovery', () => {
  it.each([
    'invalid_argument',
    'automation_destination_invalid',
    'selector_not_found',
    'selector_ambiguous'
  ])(
    'sends corrected parameters after an initial %s with and without creation keys',
    async (code) => {
      for (const keyed of [false, true]) {
        const port = automationClient(() => ({ automation: savedAutomation() }))
        port.send.mockResolvedValueOnce({
          id: 'refused',
          ok: false,
          error: { code, message: 'Correct the target' }
        })
        const { result, unmount } = renderAttempt()
        const capabilities = keyed ? [AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] : []
        await act(async () => {
          await expect(
            result.current.submit(port.client, draft(), automationTargets(), capabilities, current)
          ).rejects.toThrow(code)
        })
        const corrected = { ...draft(), workspaceId: 'corrected' }
        const targets = {
          ...automationTargets(),
          workspaces: [{ ...automationTargets().workspaces[0]!, worktreeId: 'corrected' }]
        }
        await act(async () => {
          await result.current.submit(port.client, corrected, targets, capabilities, current)
        })
        const initial = port.send.mock.calls[0]?.[1]
        const next = port.send.mock.calls[1]?.[1]
        expect(port.send).toHaveBeenCalledTimes(2)
        expect(initial).toMatchObject({ workspace: 'id:workspace-1' })
        expect(next).toMatchObject({ workspace: 'id:corrected' })
        if (keyed) {
          expect(initial).toHaveProperty('creationKey', expect.any(String))
          expect(next).toHaveProperty('creationKey', expect.any(String))
          expect(next).not.toMatchObject({
            creationKey:
              initial && typeof initial === 'object' && 'creationKey' in initial
                ? initial.creationKey
                : undefined
          })
        } else {
          expect(next).toHaveProperty('creationKey', undefined)
        }
        unmount()
      }
    }
  )

  it.each(['runtime_error', 'unknown-delivery'])(
    'retains %s attempts even when a later response is a prewrite refusal',
    async (failure) => {
      const port = automationClient(() => ({ automation: savedAutomation() }))
      if (failure === 'runtime_error') {
        port.send.mockResolvedValueOnce({
          id: 'uncertain',
          ok: false,
          error: { code: failure, message: 'Flush failed' }
        })
      } else {
        port.send.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('Reply lost')))
      }
      port.send.mockResolvedValueOnce({
        id: 'refused',
        ok: false,
        error: { code: 'selector_not_found', message: 'Gone' }
      })
      const { result } = renderAttempt()
      const capabilities = [AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY]
      const prepare = vi.fn(async () => ({
        ...draft(),
        name: 'revision0',
        setupDecision: 'run' as const
      }))
      for (let index = 0; index < 2; index++) {
        await act(async () => {
          await expect(
            result.current.submit(
              port.client,
              { ...draft(), name: `revision${index}` },
              automationTargets(),
              capabilities,
              current,
              prepare
            )
          ).rejects.toThrow('may have applied')
        })
      }
      expect(port.send.mock.calls[1]?.[1]).toEqual(port.send.mock.calls[0]?.[1])
      expect(port.send.mock.calls[1]?.[1]).toMatchObject({
        name: 'revision0',
        setupDecision: 'run'
      })
      expect(prepare).toHaveBeenCalledTimes(1)
    }
  )
})

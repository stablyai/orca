import '../unused-default-rpc-methods.test-fixture'
/** Legacy parameterless clients keep the complete authority list; current clients also receive owner metadata. */
import { describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext, type RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { AUTOMATION_METHODS } from './automations'
import { AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

function method(name: string) {
  const found = eraseRpcMethods(AUTOMATION_METHODS).find((entry) => entry.name === name)
  if (!found?.params) {
    throw new Error(`missing method ${name}`)
  }
  return found
}

function runtimeStub() {
  return {
    listAutomations: vi.fn(() => [{ id: 'a1' }, { id: 'a2' }]),
    listAutomationsForScope: vi.fn((params?: { selector?: { kind: string } }) =>
      params?.selector
        ? {
            automations: [{ id: 'a1' }],
            items: [{ automationId: 'a1', selector: { kind: 'self' } }],
            orphanCount: 2
          }
        : {
            automations: [{ id: 'a1' }, { id: 'a2' }],
            items: [
              { automationId: 'a1', selector: { kind: 'self' } },
              { automationId: 'a2', selector: { kind: 'orphan', issue: 'missing' } }
            ],
            orphanCount: 1
          }
    ),
    listAutomationRuns: vi.fn(() => []),
    showAutomation: vi.fn(() => ({ id: 'a1' })),
    automationOwnerPrecondition: vi.fn(() => SSH_OWNER),
    updateAutomation: vi.fn(async () => ({ id: 'a1' })),
    deleteAutomation: vi.fn(() => ({ removed: true, id: 'a1' })),
    runAutomationNow: vi.fn(async () => ({ id: 'run-1' }))
  }
}

async function invoke(
  name: string,
  params: unknown,
  runtime: ReturnType<typeof runtimeStub>,
  context: Pick<RpcContext, 'clientCapabilities'> = {}
) {
  const target = method(name)
  // Why: mirrors the dispatcher, which turns omitted params into an empty object before parsing.
  const parsed = target.params?.safeParse(params ?? {})
  if (!parsed?.success) {
    throw parsed?.error
  }
  return await target.handler(parsed.data, {
    runtime: runtime as unknown as OrcaRuntimeService,
    ...context
  } as RpcContext)
}

const SSH_OWNER = { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } }

describe('automation.list', () => {
  it('requires an SSH scope to name the generation it expects', async () => {
    const runtime = runtimeStub()
    await expect(
      invoke('automation.list', { selector: { kind: 'ssh', targetId: 'ssh-1' } }, runtime)
    ).rejects.toBeTruthy()
  })
})

/** Use real dispatch to prove legacy literal null params normalize before parsing; the test invoke helper would mask that boundary. */
describe('automation.list from a client that sends literal null params', () => {
  it('answers with the complete authority list, not an invalid-argument error', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({
      runtime: { ...runtime, getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService,
      methods: AUTOMATION_METHODS
    })
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'automation.list',
      params: null
    }

    const response = await dispatcher.dispatch(request)

    expect(response).toMatchObject({ result: { automations: [{ id: 'a1' }, { id: 'a2' }] } })
    expect(runtime.listAutomationsForScope).toHaveBeenCalledWith({})
  })
})

describe('owner preconditions', () => {
  it('omits the owner rather than inventing one when the store cannot project it', async () => {
    const runtime = runtimeStub()
    runtime.automationOwnerPrecondition.mockReturnValue(null as never)
    expect(await invoke('automation.show', { id: 'a1' }, runtime)).toEqual({
      automation: { id: 'a1' }
    })
  })

  it('accepts an orphan precondition but never an orphan destination', async () => {
    const runtime = runtimeStub()
    await invoke(
      'automation.delete',
      { id: 'a1', expectedOwner: { selector: { kind: 'orphan' } } },
      runtime
    )
    expect(runtime.deleteAutomation).toHaveBeenCalledWith('a1', {
      selector: { kind: 'orphan' }
    })
    await expect(
      invoke(
        'automation.update',
        { id: 'a1', updates: {}, destination: { selector: { kind: 'orphan' } } },
        runtime
      )
    ).rejects.toBeTruthy()
  })

  it('rejects an SSH precondition with no registration generation', async () => {
    const runtime = runtimeStub()
    await expect(
      invoke(
        'automation.delete',
        { id: 'a1', expectedOwner: { selector: { kind: 'ssh', targetId: 'ssh-1' } } },
        runtime
      )
    ).rejects.toBeTruthy()
  })

  it('leaves the parameterless old-client shapes valid', async () => {
    const runtime = runtimeStub()
    await invoke('automation.update', { id: 'a1', updates: { enabled: false } }, runtime, {
      clientCapabilities: []
    })
    await invoke('automation.delete', { id: 'a1' }, runtime, { clientCapabilities: [] })
    await invoke('automation.runNow', { id: 'a1' }, runtime, { clientCapabilities: [] })
    await invoke('automation.runs', {}, runtime)
    expect(runtime.updateAutomation).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({ enabled: false }),
      { expectedOwner: SSH_OWNER, destination: undefined }
    )
    expect(runtime.deleteAutomation).toHaveBeenCalledWith('a1', SSH_OWNER)
    expect(runtime.runAutomationNow).toHaveBeenCalledWith('a1', SSH_OWNER)
    expect(runtime.listAutomationRuns).toHaveBeenCalledWith(undefined, undefined)
  })

  it('keeps missing owner metadata fenced for a current remote client', async () => {
    const runtime = runtimeStub()
    await invoke('automation.delete', { id: 'a1' }, runtime, {
      clientCapabilities: [AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY]
    })
    expect(runtime.deleteAutomation).toHaveBeenCalledWith('a1', undefined)
  })
})

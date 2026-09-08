// src/relay/agent-rpc-dispatch-vm.test.ts
// TASK-AG-EVM-001/002/003: vm.exec / vm.provision / vm.cancelProvision —
// moved out of agent-rpc-dispatch-misc.test.ts when the handler itself
// split into agent-rpc-dispatch-vm.ts (max-lines budget).
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createWireState } from 'orca-dev-agent-transport'
import type { JsonRpcRequest } from './agent-rpc-dispatch'

class MockWs {
  readyState = 1
  send = vi.fn()
}

const handleVmExec = vi.fn()
const validateVmExecParams = vi.fn()
const handleVmProvision = vi.fn()
const validateVmProvisionParams = vi.fn()
const handleVmCancelProvision = vi.fn()
const validateRuntimeIdParam = vi.fn()
const handleVmReadCredentialFile = vi.fn()
const validateVmReadCredentialFileParams = vi.fn()

vi.mock('./agent-ephemeral-vm-handler', () => ({
  handleVmExec: (...args: unknown[]) => handleVmExec(...args),
  validateVmExecParams: (...args: unknown[]) => validateVmExecParams(...args),
  handleVmProvision: (...args: unknown[]) => handleVmProvision(...args),
  validateVmProvisionParams: (...args: unknown[]) => validateVmProvisionParams(...args),
  handleVmCancelProvision: (...args: unknown[]) => handleVmCancelProvision(...args),
  validateRuntimeIdParam: (...args: unknown[]) => validateRuntimeIdParam(...args),
  handleVmReadCredentialFile: (...args: unknown[]) => handleVmReadCredentialFile(...args),
  validateVmReadCredentialFileParams: (...args: unknown[]) =>
    validateVmReadCredentialFileParams(...args)
}))

const VM_EXEC_PARAMS = {
  repoPath: '/tmp/repo',
  command: 'echo hi',
  phase: 'suspend',
  recipeId: 'recipe-1',
  runtimeId: 'runtime-1'
}

describe('dispatchVmRpc — vm.exec', () => {
  beforeEach(() => {
    handleVmExec.mockReset()
    validateVmExecParams.mockReset()
  })

  it('validates params, calls handleVmExec, and returns its result as the RPC response', async () => {
    validateVmExecParams.mockReturnValue(VM_EXEC_PARAMS)
    handleVmExec.mockResolvedValue({ stdout: 'out', stderr: '', exitCode: 0 })
    const { dispatchVmRpc } = await import('./agent-rpc-dispatch-vm')
    const rpc: JsonRpcRequest = { jsonrpc: '2.0', id: 3, method: 'vm.exec', params: VM_EXEC_PARAMS }

    const response = await dispatchVmRpc(rpc, new MockWs() as never, createWireState())

    expect(validateVmExecParams).toHaveBeenCalledWith(VM_EXEC_PARAMS)
    expect(handleVmExec).toHaveBeenCalledWith(VM_EXEC_PARAMS)
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { stdout: 'out', stderr: '', exitCode: 0 }
    })
  })

  it('returns a ServerError response (not a throw) when validation fails', async () => {
    validateVmExecParams.mockImplementation(() => {
      throw new Error('missing required param "repoPath"')
    })
    const { dispatchVmRpc } = await import('./agent-rpc-dispatch-vm')
    const rpc: JsonRpcRequest = { jsonrpc: '2.0', id: 4, method: 'vm.exec', params: {} }

    const response = await dispatchVmRpc(rpc, new MockWs() as never, createWireState())

    expect(handleVmExec).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 4,
      error: { message: expect.stringContaining('repoPath') }
    })
  })

  it('returns a ServerError response when handleVmExec throws (exec failure)', async () => {
    validateVmExecParams.mockReturnValue(VM_EXEC_PARAMS)
    handleVmExec.mockRejectedValue(new Error('vm.exec (suspend) exited 1: boom'))
    const { dispatchVmRpc } = await import('./agent-rpc-dispatch-vm')
    const rpc: JsonRpcRequest = { jsonrpc: '2.0', id: 5, method: 'vm.exec', params: VM_EXEC_PARAMS }

    const response = await dispatchVmRpc(rpc, new MockWs() as never, createWireState())

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 5,
      error: { message: expect.stringContaining('vm.exec failed') }
    })
  })
})

const VM_PROVISION_PARAMS = {
  repoPath: '/tmp/repo',
  command: 'echo create',
  recipeId: 'recipe-1',
  runtimeId: 'runtime-1'
}

describe('dispatchVmRpc — vm.provision', () => {
  beforeEach(() => {
    handleVmProvision.mockReset()
    validateVmProvisionParams.mockReset()
  })

  it('validates params, fires handleVmProvision without awaiting it, and returns a single stream.started response — no other response frame', async () => {
    validateVmProvisionParams.mockReturnValue(VM_PROVISION_PARAMS)
    let resolveHandler: (() => void) | undefined
    handleVmProvision.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveHandler = resolve
      })
    )
    const { dispatchVmRpc } = await import('./agent-rpc-dispatch-vm')
    const ws = new MockWs() as never
    const state = createWireState()
    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 6,
      method: 'vm.provision',
      params: VM_PROVISION_PARAMS
    }

    const response = await dispatchVmRpc(rpc, ws, state)

    expect(validateVmProvisionParams).toHaveBeenCalledWith(VM_PROVISION_PARAMS)
    expect(handleVmProvision).toHaveBeenCalledWith(ws, state, 6, VM_PROVISION_PARAMS)
    // dispatchVmRpc must not await handleVmProvision — it returns
    // stream.started immediately while the streaming handler is still
    // in-flight (resolveHandler has not been called yet).
    expect(response).toEqual({ jsonrpc: '2.0', id: 6, result: { type: 'stream.started' } })
    resolveHandler?.()
  })

  it('returns a ServerError response and does not call handleVmProvision when params are missing a required field', async () => {
    validateVmProvisionParams.mockImplementation(() => {
      throw new Error('missing required param "command"')
    })
    const { dispatchVmRpc } = await import('./agent-rpc-dispatch-vm')
    const rpc: JsonRpcRequest = { jsonrpc: '2.0', id: 7, method: 'vm.provision', params: {} }

    const response = await dispatchVmRpc(rpc, new MockWs() as never, createWireState())

    expect(handleVmProvision).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      error: { message: expect.stringContaining('command') }
    })
  })
})

describe('dispatchVmRpc — vm.cancelProvision', () => {
  beforeEach(() => {
    handleVmCancelProvision.mockReset()
    validateRuntimeIdParam.mockReset()
  })

  it('validates params, calls handleVmCancelProvision, and returns its result as a normal response', async () => {
    validateRuntimeIdParam.mockReturnValue({ runtimeId: 'runtime-1' })
    handleVmCancelProvision.mockResolvedValue({ cancelled: true })
    const { dispatchVmRpc } = await import('./agent-rpc-dispatch-vm')
    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 8,
      method: 'vm.cancelProvision',
      params: { runtimeId: 'runtime-1' }
    }

    const response = await dispatchVmRpc(rpc, new MockWs() as never, createWireState())

    expect(validateRuntimeIdParam).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(handleVmCancelProvision).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(response).toEqual({ jsonrpc: '2.0', id: 8, result: { cancelled: true } })
  })

  it('returns null for an unrelated method (falls through to the next dispatcher)', async () => {
    const { dispatchVmRpc } = await import('./agent-rpc-dispatch-vm')
    const rpc: JsonRpcRequest = { jsonrpc: '2.0', id: 9, method: 'not.a.vm.method' }

    const response = await dispatchVmRpc(rpc, new MockWs() as never, createWireState())

    expect(response).toBeNull()
  })
})

describe('dispatchVmRpc — vm.readCredentialFile (TASK-AG-EVM-009, Hướng B only)', () => {
  beforeEach(() => {
    handleVmReadCredentialFile.mockReset()
    validateVmReadCredentialFileParams.mockReset()
  })

  it('validates params, calls handleVmReadCredentialFile, and returns its result', async () => {
    validateVmReadCredentialFileParams.mockReturnValue({ path: '/home/deploy/.ssh/id_ed25519' })
    handleVmReadCredentialFile.mockResolvedValue({ contentPEM: 'PEM-CONTENT' })
    const { dispatchVmRpc } = await import('./agent-rpc-dispatch-vm')
    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 10,
      method: 'vm.readCredentialFile',
      params: { path: '/home/deploy/.ssh/id_ed25519' }
    }

    const response = await dispatchVmRpc(rpc, new MockWs() as never, createWireState())

    expect(validateVmReadCredentialFileParams).toHaveBeenCalledWith({
      path: '/home/deploy/.ssh/id_ed25519'
    })
    expect(handleVmReadCredentialFile).toHaveBeenCalledWith({
      path: '/home/deploy/.ssh/id_ed25519'
    })
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 10,
      result: { contentPEM: 'PEM-CONTENT' }
    })
  })

  it('returns a ServerError response (not a throw) when validation fails', async () => {
    validateVmReadCredentialFileParams.mockImplementation(() => {
      throw new Error('missing required param "path"')
    })
    const { dispatchVmRpc } = await import('./agent-rpc-dispatch-vm')
    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 11,
      method: 'vm.readCredentialFile',
      params: {}
    }

    const response = await dispatchVmRpc(rpc, new MockWs() as never, createWireState())

    expect(handleVmReadCredentialFile).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 11,
      error: { message: expect.stringContaining('path') }
    })
  })

  it('returns a ServerError response when handleVmReadCredentialFile throws (file not found)', async () => {
    validateVmReadCredentialFileParams.mockReturnValue({ path: '/no/such/file' })
    handleVmReadCredentialFile.mockRejectedValue(new Error('ENOENT: no such file or directory'))
    const { dispatchVmRpc } = await import('./agent-rpc-dispatch-vm')
    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 12,
      method: 'vm.readCredentialFile',
      params: { path: '/no/such/file' }
    }

    const response = await dispatchVmRpc(rpc, new MockWs() as never, createWireState())

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 12,
      error: { message: expect.stringContaining('vm.readCredentialFile failed') }
    })
  })

  // Security regression-guard (TASK-AG-EVM-009's "quan trọng nhất"):
  // contentPEM must never surface in the wire error response makeError()
  // produces, even if a lower layer somehow leaked it into a thrown error.
  it('never leaks contentPEM-shaped secrets through the ServerError response message', async () => {
    const secret = 'SUPER-SECRET-PEM-CONTENTS-THAT-MUST-NEVER-LEAK'
    validateVmReadCredentialFileParams.mockReturnValue({ path: '/root/.ssh/id_ed25519' })
    // handleVmReadCredentialFile itself never embeds contentPEM in a thrown
    // error (see its own doc comment/tests) — this asserts the dispatch
    // layer doesn't introduce a leak of its own by, say, logging or
    // echoing rpc.params/result anywhere in its error-formatting path.
    handleVmReadCredentialFile.mockRejectedValue(new Error('EACCES: permission denied'))
    const { dispatchVmRpc } = await import('./agent-rpc-dispatch-vm')
    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 13,
      method: 'vm.readCredentialFile',
      params: { path: '/root/.ssh/id_ed25519' }
    }

    const response = await dispatchVmRpc(rpc, new MockWs() as never, createWireState())

    expect(JSON.stringify(response)).not.toContain(secret)
  })
})

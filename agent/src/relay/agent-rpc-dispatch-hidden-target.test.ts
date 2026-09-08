// src/relay/agent-rpc-dispatch-hidden-target.test.ts
// TASK-AG-EVM-006: vm.sshDial.
// TASK-AG-EVM-007: fs.readDirViaHiddenTarget / fs.readFileViaHiddenTarget /
// git.statusViaHiddenTarget.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { JsonRpcRequest } from './agent-rpc-dispatch'

const handleVmSshDial = vi.fn()
const validateVmSshDialParams = vi.fn()

vi.mock('./agent-ephemeral-vm-handler', () => ({
  handleVmSshDial: (...args: unknown[]) => handleVmSshDial(...args),
  validateVmSshDialParams: (...args: unknown[]) => validateVmSshDialParams(...args)
}))

const readDirViaHiddenTarget = vi.fn()
const validateReadDirViaHiddenTargetParams = vi.fn()
const readFileViaHiddenTarget = vi.fn()
const validateReadFileViaHiddenTargetParams = vi.fn()

vi.mock('./ssh-outbound-filesystem-provider', () => ({
  readDirViaHiddenTarget: (...args: unknown[]) => readDirViaHiddenTarget(...args),
  validateReadDirViaHiddenTargetParams: (...args: unknown[]) =>
    validateReadDirViaHiddenTargetParams(...args),
  readFileViaHiddenTarget: (...args: unknown[]) => readFileViaHiddenTarget(...args),
  validateReadFileViaHiddenTargetParams: (...args: unknown[]) =>
    validateReadFileViaHiddenTargetParams(...args)
}))

const gitStatusViaHiddenTarget = vi.fn()
const validateGitStatusViaHiddenTargetParams = vi.fn()

vi.mock('./ssh-outbound-git-provider', () => ({
  gitStatusViaHiddenTarget: (...args: unknown[]) => gitStatusViaHiddenTarget(...args),
  validateGitStatusViaHiddenTargetParams: (...args: unknown[]) =>
    validateGitStatusViaHiddenTargetParams(...args)
}))

const VM_SSH_DIAL_PARAMS = {
  runtimeId: 'runtime-ssh-1',
  target: { label: 'vm-1', host: 'vm1.example.com', port: 22, username: 'deploy' },
  privateKeyPEM: 'PEM-DATA'
}

describe('dispatchHiddenTargetRpc — vm.sshDial', () => {
  beforeEach(() => {
    handleVmSshDial.mockReset()
    validateVmSshDialParams.mockReset()
  })

  it('validates params, calls handleVmSshDial, and returns its result as a normal response', async () => {
    validateVmSshDialParams.mockReturnValue(VM_SSH_DIAL_PARAMS)
    handleVmSshDial.mockResolvedValue({ hiddenTargetId: 'runtime-ssh-1' })
    const { dispatchHiddenTargetRpc } = await import('./agent-rpc-dispatch-hidden-target')
    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'vm.sshDial',
      params: VM_SSH_DIAL_PARAMS
    }

    const response = await dispatchHiddenTargetRpc(rpc)

    expect(validateVmSshDialParams).toHaveBeenCalledWith(VM_SSH_DIAL_PARAMS)
    expect(handleVmSshDial).toHaveBeenCalledWith(VM_SSH_DIAL_PARAMS)
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { hiddenTargetId: 'runtime-ssh-1' }
    })
  })

  it('returns a ServerError response (not a throw) when validation fails', async () => {
    validateVmSshDialParams.mockImplementation(() => {
      throw new Error('vm.sshDial: missing required param "runtimeId"')
    })
    const { dispatchHiddenTargetRpc } = await import('./agent-rpc-dispatch-hidden-target')
    const rpc: JsonRpcRequest = { jsonrpc: '2.0', id: 2, method: 'vm.sshDial', params: {} }

    const response = await dispatchHiddenTargetRpc(rpc)

    expect(handleVmSshDial).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      error: { message: expect.stringContaining('runtimeId') }
    })
  })

  it('security regression-guard: a dial failure error routed through makeError never contains privateKeyPEM', async () => {
    const secret = 'SUPER-SECRET-PRIVATE-KEY'
    validateVmSshDialParams.mockReturnValue({ ...VM_SSH_DIAL_PARAMS, privateKeyPEM: secret })
    // Even if a lower layer leaked the secret into an error message, the
    // dispatch case's `vm.sshDial failed: ${msg}` wrapping must not be the
    // only place expected to catch it — this asserts the secret used in
    // this test's own params never appears in the response the wire sees.
    handleVmSshDial.mockRejectedValue(new Error('dial failed: auth error'))
    const { dispatchHiddenTargetRpc } = await import('./agent-rpc-dispatch-hidden-target')
    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 3,
      method: 'vm.sshDial',
      params: { ...VM_SSH_DIAL_PARAMS, privateKeyPEM: secret }
    }

    const response = await dispatchHiddenTargetRpc(rpc)

    // dispatchHiddenTargetRpc takes no logger — the only place the secret
    // could leak from here is the response the wire sees.
    expect(JSON.stringify(response)).not.toContain(secret)
  })
})

describe('dispatchHiddenTargetRpc — fs.readDirViaHiddenTarget / fs.readFileViaHiddenTarget', () => {
  beforeEach(() => {
    readDirViaHiddenTarget.mockReset()
    validateReadDirViaHiddenTargetParams.mockReset()
    readFileViaHiddenTarget.mockReset()
    validateReadFileViaHiddenTargetParams.mockReset()
  })

  it('validates params, calls readDirViaHiddenTarget, and returns its result', async () => {
    const params = { hiddenTargetId: 'rt-1', path: '/srv/app' }
    validateReadDirViaHiddenTargetParams.mockReturnValue(params)
    readDirViaHiddenTarget.mockResolvedValue({ entries: [{ name: 'a.txt', type: 'file' }] })
    const { dispatchHiddenTargetRpc } = await import('./agent-rpc-dispatch-hidden-target')
    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 4,
      method: 'fs.readDirViaHiddenTarget',
      params
    }

    const response = await dispatchHiddenTargetRpc(rpc)

    expect(validateReadDirViaHiddenTargetParams).toHaveBeenCalledWith(params)
    expect(readDirViaHiddenTarget).toHaveBeenCalledWith(params)
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { entries: [{ name: 'a.txt', type: 'file' }] }
    })
  })

  it('returns a ServerError response when the hidden target session is not registered', async () => {
    validateReadDirViaHiddenTargetParams.mockReturnValue({
      hiddenTargetId: 'no-such',
      path: '/srv'
    })
    readDirViaHiddenTarget.mockRejectedValue(new Error('No hidden target session for id "no-such"'))
    const { dispatchHiddenTargetRpc } = await import('./agent-rpc-dispatch-hidden-target')
    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 5,
      method: 'fs.readDirViaHiddenTarget',
      params: { hiddenTargetId: 'no-such', path: '/srv' }
    }

    const response = await dispatchHiddenTargetRpc(rpc)

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 5,
      error: { message: expect.stringContaining('No hidden target session') }
    })
  })

  it('validates params, calls readFileViaHiddenTarget, and returns its result', async () => {
    const params = { hiddenTargetId: 'rt-1', path: '/srv/app/a.txt' }
    validateReadFileViaHiddenTargetParams.mockReturnValue(params)
    readFileViaHiddenTarget.mockResolvedValue({ content: 'aGVsbG8=', encoding: 'base64' })
    const { dispatchHiddenTargetRpc } = await import('./agent-rpc-dispatch-hidden-target')
    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 6,
      method: 'fs.readFileViaHiddenTarget',
      params
    }

    const response = await dispatchHiddenTargetRpc(rpc)

    expect(validateReadFileViaHiddenTargetParams).toHaveBeenCalledWith(params)
    expect(readFileViaHiddenTarget).toHaveBeenCalledWith(params)
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 6,
      result: { content: 'aGVsbG8=', encoding: 'base64' }
    })
  })
})

describe('dispatchHiddenTargetRpc — git.statusViaHiddenTarget', () => {
  beforeEach(() => {
    gitStatusViaHiddenTarget.mockReset()
    validateGitStatusViaHiddenTargetParams.mockReset()
  })

  it('validates params, calls gitStatusViaHiddenTarget, and returns its result', async () => {
    const params = { hiddenTargetId: 'rt-1', repoPath: '/srv/app' }
    validateGitStatusViaHiddenTargetParams.mockReturnValue(params)
    gitStatusViaHiddenTarget.mockResolvedValue({ branch: 'main', ahead: 0, behind: 0, files: [] })
    const { dispatchHiddenTargetRpc } = await import('./agent-rpc-dispatch-hidden-target')
    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 7,
      method: 'git.statusViaHiddenTarget',
      params
    }

    const response = await dispatchHiddenTargetRpc(rpc)

    expect(validateGitStatusViaHiddenTargetParams).toHaveBeenCalledWith(params)
    expect(gitStatusViaHiddenTarget).toHaveBeenCalledWith(params)
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { branch: 'main', ahead: 0, behind: 0, files: [] }
    })
  })

  it('returns a ServerError response (not a throw) when validation fails', async () => {
    validateGitStatusViaHiddenTargetParams.mockImplementation(() => {
      throw new Error('git.statusViaHiddenTarget: missing required param "repoPath"')
    })
    const { dispatchHiddenTargetRpc } = await import('./agent-rpc-dispatch-hidden-target')
    const rpc: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 8,
      method: 'git.statusViaHiddenTarget',
      params: { hiddenTargetId: 'rt-1' }
    }

    const response = await dispatchHiddenTargetRpc(rpc)

    expect(gitStatusViaHiddenTarget).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 8,
      error: { message: expect.stringContaining('repoPath') }
    })
  })

  it('returns null (falls through) for an unrelated method', async () => {
    const { dispatchHiddenTargetRpc } = await import('./agent-rpc-dispatch-hidden-target')
    const rpc: JsonRpcRequest = { jsonrpc: '2.0', id: 9, method: 'fs.readDir', params: {} }
    await expect(dispatchHiddenTargetRpc(rpc)).resolves.toBeNull()
  })
})

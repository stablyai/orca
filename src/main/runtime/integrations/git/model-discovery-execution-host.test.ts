import { describe, expect, it } from 'vitest'
import { ExecutionHostNotDispatchableError } from '../../../providers/execution-host-provider-dispatch'
import {
  modelDiscoveryExecutionHost,
  modelDiscoveryWorkspaceForHost
} from './model-discovery-execution-host'

describe('model discovery execution host', () => {
  it('refuses a runtime git workspace instead of probing this machine', () => {
    const executionHostId = modelDiscoveryExecutionHost({
      folder: null,
      gitExecutionHostId: 'runtime:env-1'
    })
    expect(executionHostId).toBe('runtime:env-1')
    expect(() => modelDiscoveryWorkspaceForHost({ path: '/srv/app', executionHostId })).toThrow(
      ExecutionHostNotDispatchableError
    )
  })

  it('refuses a runtime folder instead of dialing its nested SSH id', () => {
    const executionHostId = modelDiscoveryExecutionHost({
      folder: { executionHostId: 'runtime:env-1', connectionId: 'shared-name' },
      gitExecutionHostId: null
    })
    expect(executionHostId).toBe('runtime:env-1')
    expect(() => modelDiscoveryWorkspaceForHost({ path: '/srv/notes', executionHostId })).toThrow(
      ExecutionHostNotDispatchableError
    )
    try {
      modelDiscoveryWorkspaceForHost({ path: '/srv/notes', executionHostId })
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionHostNotDispatchableError)
      expect(String(error)).not.toContain('shared-name')
    }
  })
})

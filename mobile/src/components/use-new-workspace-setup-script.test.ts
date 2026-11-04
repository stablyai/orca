import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'
import { useNewWorkspaceSetupScript } from './use-new-workspace-setup-script'

type SetupScript = ReturnType<typeof useNewWorkspaceSetupScript>
const repo: MobileWorkspaceRepo = { id: 'repo', displayName: 'Orca', path: '/orca' }
const hooks: RpcResponse = {
  id: 'hooks',
  ok: true,
  result: {
    hooks: { scripts: { setup: 'pnpm install' } },
    source: 'orca.yaml',
    setupRunPolicy: 'ask',
    setupTrust: { contentHash: 'hash', scriptContent: 'pnpm install' }
  }
}

describe('new workspace setup choices', () => {
  let renderer: ReactTestRenderer | null = null
  let script: SetupScript | null = null
  function current(): SetupScript {
    if (!script) {
      throw new Error('Setup hook did not render')
    }
    return script
  }
  function Harness(props: { client: RpcClient; selectedRepo: MobileWorkspaceRepo }) {
    script = useNewWorkspaceSetupScript(props)
    return null
  }
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    script = null
  })
  it('retains the user choice when repo.list refreshes the same repository object', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockResolvedValue(hooks)
    await act(async () => {
      renderer = create(createElement(Harness, { client, selectedRepo: repo }))
    })
    act(() => {
      current().setSetupDecisionChoice('skip')
      current().setRunSetup(false)
      current().setShowAdvanced(false)
    })
    await act(async () =>
      renderer?.update(createElement(Harness, { client, selectedRepo: { ...repo } }))
    )
    expect(current().setupDecisionChoice).toBe('skip')
    expect(current().runSetup).toBe(false)
    expect(current().showAdvanced).toBe(false)
  })
  it('does not show another runtime’s setup script for a repository with the same id', async () => {
    const previous = new FakeSession('connected')
    previous.sendRequest.mockResolvedValue(hooks)
    await act(async () => {
      renderer = create(createElement(Harness, { client: previous, selectedRepo: repo }))
    })
    act(() => current().setSetupDecisionChoice('run'))
    const next = new FakeSession('connected')
    next.sendRequest.mockImplementation(() => new Promise<RpcResponse>(() => {}))
    await act(async () =>
      renderer?.update(
        createElement(Harness, {
          client: next,
          selectedRepo: { ...repo, executionHostId: 'runtime:server' }
        })
      )
    )
    expect(current().setupCommand).toBeNull()
    expect(current().setupTrust).toBeNull()
    expect(current().setupDecisionChoice).toBeNull()
  })
})

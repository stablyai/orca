import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_WORKSPACE_SOURCE_SELECTOR_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import type { ResolvedNewWorkspaceSource } from './new-workspace-source-types'
import {
  useNewWorkspaceSource,
  type NewWorkspaceSourceController
} from './use-new-workspace-source'

type HookArgs = Parameters<typeof useNewWorkspaceSource>[0]

const client = {
  sendRequest: vi.fn().mockResolvedValue({
    id: 'linear-status',
    ok: true,
    result: { connected: false },
    _meta: { runtimeId: 'runtime-1' }
  })
} as unknown as RpcClient
const capabilities = [MOBILE_WORKSPACE_SOURCE_SELECTOR_RUNTIME_CAPABILITY]
let controller: NewWorkspaceSourceController | null = null
let renderer: ReactTestRenderer | null = null

function Harness(props: HookArgs): null {
  controller = useNewWorkspaceSource(props)
  return null
}

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => spy.mockRestore()
}

function hookArgs(overrides: Partial<HookArgs> = {}): HookArgs {
  return {
    visible: true,
    client,
    capabilities,
    repo: { id: 'repo-1', displayName: 'App', kind: 'git' },
    repoConnected: true,
    sshStateGeneration: 0,
    ...overrides
  }
}

async function mountHook(): Promise<void> {
  const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
  try {
    await act(async () => {
      renderer = create(createElement(Harness, hookArgs()))
      await Promise.resolve()
    })
  } finally {
    restoreConsoleError()
  }
}

function githubSource(): ResolvedNewWorkspaceSource {
  return {
    kind: 'github',
    item: { type: 'issue', number: 7, title: 'Fix mobile source' } as never,
    suggestedName: 'fix-mobile-source',
    displayName: 'Issue 7 · Fix mobile source',
    forkWarning: null
  }
}

function branchSource(): ResolvedNewWorkspaceSource {
  return {
    kind: 'branch',
    refName: 'feature/mobile',
    localBranchName: 'feature/mobile',
    verified: true,
    branchAutoName: 'feature/mobile',
    branchNameOverride: 'feature/mobile',
    reuseEligibleBranch: 'feature/mobile',
    reuseEnabled: true
  }
}

describe('useNewWorkspaceSource availability lifecycle', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    controller = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('drops a capability-gated source and clears its source-owned name', async () => {
    await mountHook()
    act(() => controller?.selectSource(githubSource()))
    expect(controller?.name).toEqual({ value: 'fix-mobile-source', owner: 'source' })

    act(() => renderer?.update(createElement(Harness, hookArgs({ capabilities: [] }))))

    expect(controller?.source).toBeNull()
    expect(controller?.name).toEqual({ value: '', owner: 'blank' })
  })

  it('preserves a manual name when the selected kind becomes unavailable', async () => {
    await mountHook()
    act(() => {
      controller?.selectSource(branchSource())
      controller?.setManualName('my workspace')
    })

    act(() => {
      renderer?.update(
        createElement(
          Harness,
          hookArgs({ repo: { id: 'repo-1', displayName: 'App', kind: 'folder' } })
        )
      )
    })

    expect(controller?.source).toBeNull()
    expect(controller?.name).toEqual({ value: 'my workspace', owner: 'user' })
  })
})

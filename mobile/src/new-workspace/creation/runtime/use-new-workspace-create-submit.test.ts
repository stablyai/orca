import { useState } from 'react'
import { act } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { FakeSession } from '../../../transport/connection/mobile-endpoint-supervisor-test-fakes'
import { hookMount } from '../../../test-support/rpc-recording/react-mounting/hook-mount'
import { useMobileComposerSource } from '../../source-selection/use-mobile-composer-source'
import type { MobileWorkspaceRepo } from '../forms/new-worktree-modal-types'
import { useNewWorkspaceCreateSubmit } from './use-new-workspace-create-submit'

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))

it('resolves a redirected work item default on the selected host when repository ids repeat', async () => {
  const selectedRepo: MobileWorkspaceRepo = {
    id: 'source',
    displayName: 'Source',
    path: '/source',
    executionHostId: 'runtime:chosen'
  }
  const client = new FakeSession('connected')
  const resolutions: unknown[] = []
  client.sendRequest.mockImplementation(async (method, params) => {
    if (method === 'settings.get') {
      return { id: 'settings', ok: true, result: { settings: {} } }
    }
    if (method === 'status.get') {
      return { id: 'status', ok: true, result: { capabilities: ['project.default-agent.v1'] } }
    }
    if (method === 'agent.resolveDefault') {
      resolutions.push(params)
      return {
        id: 'default',
        ok: false,
        error: { code: 'invalid_argument', message: 'Codex unavailable on selected host' }
      }
    }
    throw new Error(`Unexpected side effect: ${method}`)
  })
  let current: {
    composer: ReturnType<typeof useMobileComposerSource>
    submit: ReturnType<typeof useNewWorkspaceCreateSubmit>
    error: string
  } | null = null
  const mounted = hookMount(() => {
    const [error, setError] = useState('')
    const composer = useMobileComposerSource({ client, selectedRepoId: 'source' })
    const submit = useNewWorkspaceCreateSubmit({
      client,
      selectedRepo,
      repos: [
        { id: 'target', displayName: 'Local twin', path: '/local' },
        {
          id: 'target',
          displayName: 'Remote target',
          path: '/remote',
          executionHostId: 'runtime:chosen'
        }
      ],
      selectedAgent: { id: 'claude', label: 'Claude' },
      agentOverridden: false,
      setSelectedAgent: () => {},
      setAgentOverridden: () => {},
      runtimeSettings: null,
      setRuntimeSettings: () => {},
      detectedAgentIds: null,
      sshGate: {
        status: null,
        requiresConnection: false,
        connectInProgress: false,
        error: null,
        needsDesktopServerRecovery: false
      },
      composer,
      note: '',
      retiredWorktreeNames: { exhaustedTiers: 0, names: [] },
      setupCommand: null,
      setupRunPolicy: 'skip-by-default',
      setupDecisionChoice: null,
      runSetup: false,
      trustedOrcaHooks: {},
      setTrustedOrcaHooks: () => {},
      getWorktreeCreateCutoverSupport: async () => false,
      getAgentLaunchSupport: async () => false,
      getBranchIntentSupport: async () => false,
      transitionDrawer: () => {},
      setError,
      onCreated: () => {},
      onClose: () => {}
    })
    current = { composer, submit, error }
  })
  const state = () => {
    if (!current) {
      throw new Error('Hook not mounted')
    }
    return current
  }
  try {
    mounted.mount()
    act(() => {
      state().composer.handleSmartGitHubItemSelect({
        id: 'issue',
        type: 'issue',
        number: 42,
        title: 'Fix target',
        state: 'open',
        url: 'https://github.com/example/target/issues/42',
        labels: [],
        updatedAt: '',
        author: null,
        repoId: 'target'
      })
    })
    await act(async () => state().submit.create())
    expect(resolutions).toEqual([{ repo: 'id:target', repoHostId: 'runtime:chosen' }])
    expect(state().error).toBe('Codex unavailable on selected host')
  } finally {
    await mounted.unmount()
  }
})

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../../../transport/connection/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { useMobilePrAiTriage } from './use-mobile-pr-ai-triage'
import * as launchModule from './pr-ai-triage-launch'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

type TriageHook = ReturnType<typeof useMobilePrAiTriage>

const fakeClient = new FakeSession('connected')

describe('useMobilePrAiTriage', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: TriageHook | null = null

  function current(): TriageHook {
    if (!hook) {
      throw new Error('Hook not rendered')
    }
    return hook
  }

  function Harness(props: { client: RpcClient | null; worktreeId: string }) {
    hook = useMobilePrAiTriage({
      client: props.client,
      connState: 'connected',
      worktreeId: props.worktreeId,
      workspaceLabel: 'Workspace',
      hostCapabilities: ['source_control_agent_launch'],
      hostStatusPending: false,
      hostStatusReadable: true
    })
    return null
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    vi.restoreAllMocks()
  })

  it('scopes launch notice to originating workspace when active worktree changes mid-launch', async () => {
    let resolveLaunch!: (value: launchModule.MobilePromptedAgentLaunch) => void
    const launchPromise = new Promise<launchModule.MobilePromptedAgentLaunch>((resolve) => {
      resolveLaunch = resolve
    })

    vi.spyOn(launchModule, 'launchAgentWithPrompt').mockReturnValue(launchPromise)

    await act(async () => {
      renderer = create(createElement(Harness, { client: fakeClient, worktreeId: 'worktree-1' }))
    })

    // Start launch in workspace 1
    let launchFinished = false
    act(() => {
      void current()
        .launch('fix-checks', () => 'fix this')
        .then(() => {
          launchFinished = true
        })
    })

    // Switch workspace to worktree-2 while launch is still in flight
    await act(async () => {
      renderer?.update(createElement(Harness, { client: fakeClient, worktreeId: 'worktree-2' }))
    })

    // Complete the launch
    await act(async () => {
      resolveLaunch({
        kind: 'sent',
        opens: { worktreeId: 'worktree-1', paneKey: 'pane-1' }
      })
    })

    expect(launchFinished).toBe(true)

    // In worktree-2, noticeFor returns NO_LAUNCH_NOTICE
    expect(current().noticeFor('fix-checks')).toEqual({
      success: null,
      error: null,
      warning: null,
      undeliveredPrompt: null,
      opens: null
    })

    // Switch back to worktree-1; notice is visible
    await act(async () => {
      renderer?.update(createElement(Harness, { client: fakeClient, worktreeId: 'worktree-1' }))
    })

    expect(current().noticeFor('fix-checks').success).toBeTruthy()
    expect(current().noticeFor('fix-checks').opens).toEqual({
      worktreeId: 'worktree-1',
      paneKey: 'pane-1'
    })
  })
})

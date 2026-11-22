import { expect, it, vi } from 'vitest'
import {
  fixture,
  admitRuntimeSpawnPane
} from '../../../persistence/loading-store/profile-writing/profile-state-delayed-authority-fixture'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { OrcaRuntimeService } from '../../orca-runtime'

vi.mock('../../../../shared/workspace-layout/layout-owner-switch', () => ({
  ORCA_LAYOUT_OWNER_IS_MAIN: true
}))

it('resolves refusal facts only for the exact live launch incarnation', async () => {
  const { store } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  const pane = {
    worktreeId: 'repo-local::/fixture/local',
    tabId: 'restart-facts-tab',
    leafId: '11111111-1111-4111-8111-111111111111'
  }
  const ptyId = 'restart-facts-pty'
  const paneKey = makePaneKey(pane.tabId, pane.leafId)
  await admitRuntimeSpawnPane(store, pane)
  const register = async (incarnationId: string) => {
    await store.persistPtyBinding({ ...pane, ptyId, incarnationId })
    runtime.registerPty(ptyId, pane.worktreeId, null, {
      tabId: pane.tabId,
      leafId: pane.leafId,
      incarnationId,
      agentLaunchAuthority: { launchToken: 'restart-attempt', launchAgent: 'codex' }
    })
  }
  await register('inc-refused')
  runtime.rememberSavedTerminalLaunchResult(ptyId, {
    agentResumeRefused: 'chat-home',
    agentResumeUnavailable: true,
    savedResumeDecision: {
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'conversation-1' },
      verdict: 'chat-home'
    }
  })
  const ordinary = runtime.resolveTerminalPane(paneKey, pane.worktreeId)
  expect(ordinary).toMatchObject({
    agentResumeRefused: 'chat-home',
    agentResumeUnavailable: true
  })
  expect(ordinary).not.toHaveProperty('launchToken')
  vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: pane.worktreeId,
    path: '/fixture/local',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  await expect(
    runtime.resolveAccountRestartTerminalPane(paneKey, pane.worktreeId, 'restart-attempt')
  ).resolves.toMatchObject({ accountRestart: { attempt: 'matching' } })
  await register('inc-successor')
  expect(runtime.resolveTerminalPane(paneKey, pane.worktreeId).agentResumeRefused).toBeUndefined()
})

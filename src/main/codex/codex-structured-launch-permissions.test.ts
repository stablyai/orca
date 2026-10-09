import { describe, expect, it } from 'vitest'
import { IDENTITY, record, resolverFor } from './codex-structured-launch-resolution.test-fixture'
import { withAgentChatPermissionSeed } from '../native-chat/agent-chat-permission-mode-setting'
describe('Codex saved launch permissions', () => {
  // app-server owns the permission posture on the thread RPC, not process flags.
  it('resolves the bypass posture as app-server thread policy', async () => {
    const launch = await resolverFor(
      record({
        options: withAgentChatPermissionSeed(
          'codex',
          { nativeChatPermissionMode: 'bypass' },
          undefined
        ),
        launchArgs: ['--dangerously-bypass-approvals-and-sandbox']
      }),
      undefined,
      undefined
    )({ identity: IDENTITY })

    expect(launch.args).toEqual(['app-server'])
    expect(launch.permissionPolicy).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      approvalsReviewer: 'user' as const
    })
  })

  it('bypasses approvals for a profile that never opened Agent settings', async () => {
    const launch = await resolverFor(
      record({
        options: withAgentChatPermissionSeed(
          'codex',
          { nativeChatPermissionMode: 'bypass' },
          undefined
        )
      }),
      undefined,
      undefined
    )({ identity: IDENTITY })

    expect(launch.args).toEqual(['app-server'])
    expect(launch.permissionPolicy).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      approvalsReviewer: 'user' as const
    })
  })

  // Stated, not omitted: app-server resolves an absent field through the mirrored config.toml,
  // so a Manual session on a home carrying `approval_policy = "never"` never prompted at all.
  it('states the approval posture under Manual', async () => {
    const launch = await resolverFor(record())({ identity: IDENTITY })

    expect(launch.args).toEqual(['app-server'])
    expect(launch.permissionPolicy).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      approvalsReviewer: 'user'
    })
  })

  // A resume uses only the chat's saved choice.
  it.each([
    [
      'bypass',
      { approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' as const }
    ],
    [
      'auto',
      { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' }
    ],
    ['ask', { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' }]
  ] as const)('opens a chat that chose %s in its saved mode', async (mode, policy) => {
    const launch = await resolverFor(
      record({ options: { permissionMode: mode } }),
      undefined,
      undefined
    )({ identity: IDENTITY })

    expect(launch.permissionMode).toBe(mode)
    expect(launch.permissionPolicy).toEqual(policy)
  })

  it('falls back to Ask for a stored mode Codex cannot run', async () => {
    const launch = await resolverFor(
      record({ options: { permissionMode: 'accept-edits' } }),
      undefined,
      undefined
    )({ identity: IDENTITY })

    expect(launch.permissionMode).toBe('ask')
  })
})

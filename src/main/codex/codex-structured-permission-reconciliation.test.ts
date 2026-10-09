import { createCodexStructuredLaunchResolver } from './codex-structured-launch-resolution'
import { record } from '../native-chat/agent-session-wire/structured-agent-session-restart-resume-test-harness'
import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import { dispatchCodexTurn } from './codex-structured-turn-start'
import { recordingRequest, sendTurn, turnSession } from './codex-structured-permission-test-support'
import {
  applyCodexStructuredSessionOption,
  restoredCodexSessionOptions
} from './codex-structured-session-options'
import {
  adoptCodexOpenedPermissionState,
  codexPermissionModesFor
} from './codex-structured-permission-mode'

describe('Codex policy after a lost turn/start answer', () => {
  it('keeps a newer Ask intent distinct from a held Full access turn reply', async () => {
    const turns: Record<string, unknown>[] = []
    let answer = () => {}
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
      turns.push(params ?? {})
      if (turns.length === 1) {
        await new Promise<void>((resolve) => {
          answer = resolve
        })
      }
      return { turn: { id: `turn-${turns.length}` } }
    })
    const session = turnSession(request, 'ask')
    await applyCodexStructuredSessionOption(session, 'permissionMode', 'bypass')
    const first = sendTurn(session, 'held')
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    await expect(
      applyCodexStructuredSessionOption(session, 'permissionMode', 'ask')
    ).resolves.toEqual({ permissionMode: 'ask' })
    expect(turns).toHaveLength(1)
    answer()
    await first
    expect(session.threadPermissionMode).toBe('bypass')
    expect(codexPermissionModesFor(session).current).toBe('ask')
    await sendTurn(session, 'next')
    expect(turns[1]).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite' }
    })
    expect(session.threadPermissionMode).toBe('ask')
  })

  it.each(['request timed out', 'transport closed'])(
    'restates Ask with retained roots after Full access applied and %s',
    async (failure) => {
      const turns: Record<string, unknown>[] = []
      let providerPolicy: unknown = 'on-request'
      const request = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
        turns.push(params ?? {})
        providerPolicy = params?.approvalPolicy ?? providerPolicy
        if (turns.length === 1) {
          throw new Error(failure)
        }
        return { turn: { id: 'turn-next' } }
      })
      const session = turnSession(request, 'ask')
      session.workspaceWriteRoots = ['/workspace', '/visuals']
      await applyCodexStructuredSessionOption(session, 'permissionMode', 'bypass')
      await expect(
        dispatchCodexTurn(
          session,
          {
            sessionId: 'session-1',
            clientMessageId: 'lost',
            body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
          },
          1
        )
      ).rejects.toThrow(failure)
      expect(providerPolicy).toBe('never')
      expect(session.threadPermissionMode).toBeUndefined()
      await applyCodexStructuredSessionOption(session, 'permissionMode', 'ask')
      await sendTurn(session, 'next')
      expect(turns[1]).toMatchObject({
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace', '/visuals'] }
      })
      expect(providerPolicy).toBe('on-request')
      expect(session.threadPermissionMode).toBe('ask')
      await sendTurn(session, 'confirmed')
      expect(turns[2]).not.toHaveProperty('sandboxPolicy')
    }
  )

  it('keeps the previous known mode when the provider explicitly refuses the change', async () => {
    const { request, turns } = recordingRequest()
    request.mockRejectedValueOnce(new CodexAppServerRequestError('turn/start', -1, 'refused'))
    const session = turnSession(request, 'ask')
    await applyCodexStructuredSessionOption(session, 'permissionMode', 'bypass')
    await expect(sendTurn(session, 'refused')).rejects.toThrow('refused')
    expect(session.threadPermissionMode).toBe('ask')
    await applyCodexStructuredSessionOption(session, 'permissionMode', 'ask')
    await sendTurn(session, 'still-ask')
    expect(turns[0]).not.toHaveProperty('approvalPolicy')
  })
})

describe('legacy approvals reviewer retirement', () => {
  it.each([true, false])(
    'migrates an unsuperseded legacy reviewer with support %s',
    (supported) => {
      const options = restoredCodexSessionOptions({ approvalsReviewer: 'auto_review' })
      const state = adoptCodexOpenedPermissionState(
        options,
        { permissionMode: 'auto' },
        {
          approvalsReviewerSupported: supported
        }
      )
      expect(Object.fromEntries(options)).toEqual({ permissionMode: supported ? 'auto' : 'ask' })
      expect(codexPermissionModesFor({ options, ...state }).current).toBe(
        supported ? 'auto' : 'ask'
      )
    }
  )

  it('honors a saved Ask over a legacy reviewer on every subsequent turn', async () => {
    const { request, turns } = recordingRequest()
    const session = turnSession(request)
    session.options = restoredCodexSessionOptions({
      permissionMode: 'ask',
      approvalsReviewer: 'auto_review'
    })
    await sendTurn(session, 'first')
    await sendTurn(session, 'second')
    expect(session.options.has('approvalsReviewer')).toBe(false)
    expect(turns.every((turn) => !('approvalsReviewer' in turn))).toBe(true)
  })

  it('translates older clients reviewer writes into the chat mode and removes the old key', async () => {
    const session = turnSession(recordingRequest().request)
    session.options.set('approvalsReviewer', 'auto_review')
    await expect(
      applyCodexStructuredSessionOption(session, 'approvalsReviewer', 'user')
    ).resolves.toEqual({ permissionMode: 'ask' })
    await expect(
      applyCodexStructuredSessionOption(session, 'approvalsReviewer', 'auto_review')
    ).resolves.toEqual({ permissionMode: 'auto' })
    session.approvalsReviewerSupported = false
    await expect(
      applyCodexStructuredSessionOption(session, 'approvalsReviewer', 'auto_review')
    ).rejects.toThrow(/no permission mode/)
    await expect(
      applyCodexStructuredSessionOption(session, 'approvalsReviewer', 'unknown')
    ).rejects.toThrow(/no approvals reviewer/)
  })
})

it.each([
  ['auto_review', 'auto'],
  ['user', 'ask']
] as const)('normalizes saved %s before launch to %s', async (reviewer, expected) => {
  const saved = record({ chain: [] })
  saved.options = { approvalsReviewer: reviewer }
  const launch = await createCodexStructuredLaunchResolver({
    store: { getRecord: () => saved, pinLaunchDirectory: vi.fn() },
    resolveCommand: () => 'codex',
    resolveLaunchArgs: () => [],
    resolveWorkspacePath: async () => process.cwd()
  })({
    identity: {
      sessionId: saved.sessionId,
      workspaceId: saved.location.workspaceId,
      hostId: 'local',
      agent: 'codex',
      providerHandle: null
    }
  })
  expect(launch.permissionMode).toBe(expected)
  expect(launch.permissionPolicy).toMatchObject({ approvalsReviewer: reviewer })
  expect(Object.fromEntries(restoredCodexSessionOptions(saved.options))).toEqual({
    permissionMode: expected
  })
})

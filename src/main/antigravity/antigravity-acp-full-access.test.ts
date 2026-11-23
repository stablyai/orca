import { describe, expect, it, vi } from 'vitest'
import type { RequestPermissionRequest } from '../acp/generated/acp-protocol.generated'
import { acpAnswersRequests } from '../acp/launch/acp-launch-permission-modes'
import { acpStructuredPermissionHandler } from '../acp/requests/acp-structured-permission-handler'
import { AcpStructuredPrompts } from '../acp/requests/acp-structured-prompts'
import type { AcpStructuredChild } from '../acp/session/children/acp-structured-child'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'

function makeReadyChild(permission: 'ask' | 'accept-edits' | 'full-access'): AcpStructuredChild {
  const partial: unknown = {
    lane: {},
    permission,
    turns: { acceptsRequests: true }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: acpStructuredPermissionHandler only checks lane, turns.acceptsRequests, and permission.
  return partial as AcpStructuredChild
}

function makePermissionRequest(
  overrides: Partial<RequestPermissionRequest> = {}
): RequestPermissionRequest {
  return {
    sessionId: 'session-1',
    toolCall: {
      toolCallId: 'call-1',
      title: 'Read /etc/hosts',
      kind: 'read',
      status: 'pending'
    },
    options: [
      { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
    ],
    ...overrides
  }
}

describe('ANTIGRAVITY_HOST_LAUNCH_SPEC full-access permission handling', () => {
  const hostSpec = ANTIGRAVITY_LAUNCH_SPEC.hostBackend.spec
  const context = { id: 1, signal: new AbortController().signal }

  it('enables fullAccessAnswersRequests on host agy while keeping managed yolo server unchanged', () => {
    expect(acpAnswersRequests(hostSpec)).toBe(true)
    expect(acpAnswersRequests(ANTIGRAVITY_LAUNCH_SPEC)).toBe(false)
  })

  it('auto-selects allow_once for unclaimed permission requests in full-access mode', async () => {
    const prompts = new AcpStructuredPrompts(
      () => null,
      () => true
    )
    const handle = vi.spyOn(prompts, 'handle')
    const onPermission = acpStructuredPermissionHandler(
      () => makeReadyChild('full-access'),
      hostSpec,
      prompts
    )

    const result = await onPermission(makePermissionRequest(), context)

    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(handle).not.toHaveBeenCalled()
  })

  it('still prompts for unclaimed requests outside full-access mode', async () => {
    const reply = { outcome: { outcome: 'selected', optionId: 'reject' } }
    const prompts = new AcpStructuredPrompts(
      () => null,
      () => true
    )
    const handle = vi.spyOn(prompts, 'handle').mockResolvedValue(reply)
    const onPermission = acpStructuredPermissionHandler(
      () => makeReadyChild('ask'),
      hostSpec,
      prompts
    )

    const result = await onPermission(makePermissionRequest(), context)

    expect(result).toEqual(reply)
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it('still forwards dialect-claimed interaction questions and security warnings in full-access', async () => {
    const reply = { outcome: { outcome: 'selected', optionId: 'once' } }
    const prompts = new AcpStructuredPrompts(
      () => null,
      () => true
    )
    const handle = vi.spyOn(prompts, 'handle').mockResolvedValue(reply)
    const onPermission = acpStructuredPermissionHandler(
      () => makeReadyChild('full-access'),
      hostSpec,
      prompts
    )

    await onPermission(
      makePermissionRequest({
        toolCall: { toolCallId: 'interaction_1', title: 'Proceed?', status: 'pending' }
      }),
      context
    )
    await onPermission(
      makePermissionRequest({
        options: [
          {
            optionId: 'always',
            kind: 'allow_always',
            name: 'Allow always',
            _meta: { 'agy.security.warning': { message: 'Broad access' } }
          },
          { optionId: 'once', kind: 'allow_once', name: 'Allow once' }
        ]
      }),
      context
    )

    expect(handle).toHaveBeenCalledTimes(2)
  })
})

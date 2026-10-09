import { expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import { openCodexThread } from './codex-structured-thread-open'
import {
  adoptCodexOpenedPermissionState,
  codexPermissionModesFor
} from './codex-structured-permission-mode'
import { codexStructuredPermissionPolicy } from './codex-structured-permission-policy'

it.each([null, 'thread-old'])(
  'narrows an offered Auto choice after an older app-server rejects its reviewer (%s)',
  async (resumeThreadId) => {
    const options = new Map([['permissionMode', 'auto']])
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (params && 'approvalsReviewer' in params) {
        throw new CodexAppServerRequestError(method, -32602, 'unknown field approvalsReviewer')
      }
      expect(params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
      return { thread: { id: resumeThreadId ?? 'thread-new' }, approvalsReviewer: 'user' }
    })
    const launch = {
      cwd: '/workspace',
      resumeThreadId,
      permissionMode: 'auto' as const,
      permissionPolicy: codexStructuredPermissionPolicy('auto')
    }
    const opened = await openCodexThread({ request }, launch, 50)
    const state = adoptCodexOpenedPermissionState(options, launch, opened)
    expect(Object.fromEntries(options)).toEqual({ permissionMode: 'ask' })
    expect(state.threadPermissionMode).toBe('ask')
    expect(codexPermissionModesFor({ options, ...state })).toEqual({
      current: 'ask',
      supported: ['ask', 'bypass']
    })
    expect(request).toHaveBeenCalledTimes(2)
  }
)

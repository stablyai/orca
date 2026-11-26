import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installSshRuntimeCredentialBridge,
  requestSshRuntimeCredential,
  submitSshRuntimeCredential
} from './ssh-runtime-credential-bridge'

const decline = vi.hoisted(() => vi.fn())

vi.mock('./authentication/ssh-credential-decline', () => ({
  recordSshCredentialDeclined: decline
}))

describe('SSH runtime credential bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('publishes a prompt and resolves the request without putting the answer in an event', async () => {
    const requests: unknown[] = []
    const resolved: unknown[] = []
    let cleanup = (): void => {}
    const runtime = {
      notifySshCredentialRequest: vi.fn((request: unknown) => requests.push(request)),
      notifySshCredentialResolved: vi.fn((requestId: string) => resolved.push({ requestId }))
    }
    installSshRuntimeCredentialBridge(runtime, (handler) => {
      cleanup = handler
    })

    const pending = requestSshRuntimeCredential('target-1', 'password', 'host.example', false)
    expect(requests).toEqual([
      {
        requestId: expect.any(String),
        targetId: 'target-1',
        kind: 'password',
        detail: 'host.example',
        echo: false
      }
    ])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the request shape is asserted immediately above and requestId is the only field consumed here.
    const requestId = (requests[0] as { requestId: string }).requestId

    expect(submitSshRuntimeCredential(requestId, 'secret value')).toBe(true)
    await expect(pending).resolves.toBe('secret value')
    expect(resolved).toEqual([{ requestId }])
    expect(JSON.stringify(requests)).not.toContain('secret value')
    expect(decline).not.toHaveBeenCalled()
    cleanup()
  })

  it('treats a cancelled prompt as a decline and rejects later submissions', async () => {
    const requests: { requestId: string }[] = []
    let cleanup = (): void => {}
    const runtime = {
      notifySshCredentialRequest: (request: { requestId: string }) => requests.push(request),
      notifySshCredentialResolved: vi.fn()
    }
    installSshRuntimeCredentialBridge(runtime, (handler) => {
      cleanup = handler
    })

    const pending = requestSshRuntimeCredential('target-2', 'passphrase', 'key')
    const requestId = requests[0]!.requestId
    expect(submitSshRuntimeCredential(requestId, null)).toBe(true)
    await expect(pending).resolves.toBeNull()
    expect(decline).toHaveBeenCalledWith('target-2', undefined)
    expect(submitSshRuntimeCredential(requestId, 'late answer')).toBe(false)
    cleanup()
  })
})

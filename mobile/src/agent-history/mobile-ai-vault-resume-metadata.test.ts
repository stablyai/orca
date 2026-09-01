import { describe, expect, it, vi } from 'vitest'
import { loadMobileResumeMetadata } from './mobile-ai-vault-resume-metadata'
import { MOBILE_AGENT_LAUNCH_IDENTITY_CAPABILITY } from '../session/agent-launch-identity-capability'

type Response = { ok: true; result: unknown } | { ok: false; error?: { message?: string } }

function clientReturning(byMethod: Record<string, Response | Error>): {
  sendRequest: ReturnType<typeof vi.fn>
} {
  const sendRequest = vi.fn((method: string) => {
    const entry = byMethod[method]
    if (entry instanceof Error) {
      return Promise.reject(entry)
    }
    return Promise.resolve(entry ?? { ok: false, error: { message: `no stub for ${method}` } })
  })
  return { sendRequest }
}

const OK_REPO: Response = { ok: true, result: { repos: [] } }

describe('loadMobileResumeMetadata identity capability', () => {
  it('reports the identity capability when the host advertises it', async () => {
    const metadata = await loadMobileResumeMetadata(
      clientReturning({
        'repo.list': OK_REPO,
        'status.get': {
          ok: true,
          result: { capabilities: ['other', MOBILE_AGENT_LAUNCH_IDENTITY_CAPABILITY] }
        }
      })
    )
    expect(metadata.hasIdentityCapability).toBe(true)
  })

  it('reports no capability when the host omits it (legacy host)', async () => {
    const metadata = await loadMobileResumeMetadata(
      clientReturning({
        'repo.list': OK_REPO,
        'status.get': { ok: true, result: { capabilities: [] } }
      })
    )
    expect(metadata.hasIdentityCapability).toBe(false)
  })

  it('degrades to no capability when the status probe fails', async () => {
    const metadata = await loadMobileResumeMetadata(
      clientReturning({
        'repo.list': OK_REPO,
        'status.get': new Error('unreachable')
      })
    )
    expect(metadata.hasIdentityCapability).toBe(false)
  })

  it('throws when the required repo listing fails', async () => {
    await expect(
      loadMobileResumeMetadata(
        clientReturning({
          'repo.list': { ok: false, error: { message: 'boom' } },
          'status.get': { ok: true, result: { capabilities: [] } }
        })
      )
    ).rejects.toThrow('boom')
  })
})

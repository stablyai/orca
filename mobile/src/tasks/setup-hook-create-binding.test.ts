import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { bindSetupHookCreate, resolveSetupHookCreate } from './setup-hook-create-binding'
import { hashSetupHookTrustContent } from './setup-hook-trust'

const SETUP_CONTENT = 'pnpm install'
const HASH = hashSetupHookTrustContent(SETUP_CONTENT)

function hooksClient(result: unknown): RpcClient {
  return {
    sendRequest: async () => ({ id: '1', ok: true, result, _meta: { runtimeId: 'runtime' } })
  } as unknown as RpcClient
}

describe('setup hook create binding', () => {
  it('uses host-canonical trust content even when only default-tab commands run', async () => {
    const canonicalContent = '# defaultTabs[1]\npnpm dev'
    await expect(
      resolveSetupHookCreate({
        client: hooksClient({
          hooks: { defaultTabs: [{ command: 'pnpm dev' }] },
          source: 'orca.yaml',
          setupRunPolicy: 'ask',
          setupTrust: {
            contentHash: hashSetupHookTrustContent(canonicalContent),
            scriptContent: canonicalContent,
            approvalToken: 'token'
          }
        }),
        repoId: 'repo-1'
      })
    ).resolves.toMatchObject({
      kind: 'prompt',
      command: '# defaultTabs[1]\npnpm dev',
      setupTrust: { approvalToken: 'token' }
    })
  })

  it('binds current hosts and forces old or malformed hosts to skip', () => {
    const setupTrust = {
      contentHash: HASH,
      scriptContent: SETUP_CONTENT,
      approvalToken: 'token'
    }

    expect(bindSetupHookCreate({ decision: 'run', setupTrust, approvalSupported: true })).toEqual({
      decision: 'run',
      approval: { kind: 'setup', token: 'token', contentHash: HASH }
    })
    // A downgraded run must carry a reason; an old host returns no warning of its own.
    expect(bindSetupHookCreate({ decision: 'run', setupTrust, approvalSupported: false })).toEqual({
      decision: 'skip',
      suppressedWarning: expect.stringContaining('update the remote Orca server')
    })
    expect(
      bindSetupHookCreate({ decision: 'run', setupTrust: null, approvalSupported: true })
    ).toEqual({
      decision: 'skip',
      suppressedWarning: expect.stringContaining('could be verified')
    })
    // Nothing to run, so nothing to explain.
    expect(
      bindSetupHookCreate({ decision: 'inherit', setupTrust: null, approvalSupported: false })
    ).toEqual({ decision: 'skip' })
    expect(bindSetupHookCreate({ decision: 'skip', setupTrust, approvalSupported: true })).toEqual({
      decision: 'skip'
    })
  })
})

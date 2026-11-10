import { describe, expect, it } from 'vitest'
import { EnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import type { HostedSandboxView } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import { preflightCloudWorkspaceDelete } from './cloud-delete-preflight'

function view(status: HostedSandboxView['status']): HostedSandboxView {
  return {
    id: 'sbx_1',
    workspaceId: 'ws',
    status,
    machineSize: 'standard',
    region: 'iad1',
    session: null,
    createdAt: 1
  }
}

const answering = (status: HostedSandboxView['status']) => ({ get: async () => view(status) })
const failing = (error: unknown) => ({
  get: async (): Promise<HostedSandboxView> => {
    throw error
  }
})

describe('preflightCloudWorkspaceDelete', () => {
  it('passes non-cloud workspaces straight through', async () => {
    expect(await preflightCloudWorkspaceDelete(undefined, null)).toEqual({ ok: true })
  })

  it('keeps the row when the signed-in identity cannot see the sandbox (W9 D-2)', async () => {
    const result = await preflightCloudWorkspaceDelete(
      'sbx_1',
      failing(new EnvironmentProviderError('not_found', 'gone'))
    )
    expect(result).toMatchObject({ ok: false, errorCode: 'cloudDeleteNotConfirmed' })
  })

  it('asks to sign in, and fails closed when Orca Cloud is unreachable', async () => {
    expect(
      await preflightCloudWorkspaceDelete(
        'sbx_1',
        failing(new EnvironmentProviderError('unauthorized', 'no'))
      )
    ).toMatchObject({ ok: false, errorCode: 'cloudSignInRequired' })
    expect(
      await preflightCloudWorkspaceDelete('sbx_1', failing(new Error('offline')))
    ).toMatchObject({ ok: false, errorCode: 'cloudUnavailable' })
    expect(await preflightCloudWorkspaceDelete('sbx_1', null)).toMatchObject({
      ok: false,
      errorCode: 'cloudUnavailable'
    })
  })

  it('reports an asleep sandbox so Delete can skip waking it', async () => {
    expect(await preflightCloudWorkspaceDelete('sbx_1', answering('suspended'))).toEqual({
      ok: true,
      asleep: true
    })
    expect(await preflightCloudWorkspaceDelete('sbx_1', answering('running'))).toEqual({ ok: true })
    expect(await preflightCloudWorkspaceDelete('sbx_1', answering('destroyed'))).toEqual({
      ok: true,
      gone: true
    })
  })
})

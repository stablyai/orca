import { describe, expect, it } from 'vitest'
import { createHostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'

function clientAnswering(body: unknown, status = 200) {
  const fetch: typeof globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  return createHostedSandboxControlPlaneClient({
    baseUrl: 'https://sandbox.cloud.test',
    getAccessToken: async () => 't',
    fetch
  })
}

const destroyed = {
  id: 'sbx_8f584f256a5e279daf195791',
  workspaceId: 'ws-1',
  status: 'destroyed',
  machineSize: 'standard',
  region: 'pdx1',
  session: null,
  createdAt: 1_800_000_000_000
}

describe('destroy response parsing', () => {
  it('confirms a delete even when the control plane adds view fields this build does not know (no false invalid_response)', async () => {
    const client = clientAnswering({
      sandbox: { ...destroyed, archivedAt: null, machineSize: 'xlarge', newField: { x: 1 } },
      extra: true
    })
    await expect(client.destroy(destroyed.id)).resolves.toMatchObject({
      id: destroyed.id,
      status: 'destroyed'
    })
  })

  it('still rejects a body without the sandbox id and status', async () => {
    const client = clientAnswering({ ok: true })
    await expect(client.destroy(destroyed.id)).rejects.toMatchObject({ code: 'invalid_response' })
  })
})

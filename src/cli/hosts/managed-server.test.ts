import { describe, expect, it, vi } from 'vitest'
import {
  MANAGED_SERVER_LIMITED_FORCE_RUNTIME_CAPABILITY,
  MANAGED_SERVER_RUNTIME_CAPABILITY
} from '../../shared/remote-runtime/protocol/host-runtime-capabilities'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import { MANAGED_SERVER_HANDLERS } from './managed-server'

const UNCOUNTED_DEFERRAL = {
  outcome: 'deferred',
  candidateVersion: '0.3.0+new',
  code: 'orcad_update_daemon_protocol_unverifiable',
  reason: 'The terminal daemon did not report its protocol.',
  forceable: true
}
const CURRENT_DESKTOP = [
  MANAGED_SERVER_RUNTIME_CAPABILITY,
  MANAGED_SERVER_LIMITED_FORCE_RUNTIME_CAPABILITY
]

function updateWith(
  flags: Record<string, boolean>,
  options: { result?: object; capabilities?: string[] } = {}
) {
  const { result = UNCOUNTED_DEFERRAL, capabilities = CURRENT_DESKTOP } = options
  const call = vi.fn(async (method: string, _params?: unknown) => ({
    id: '1',
    ok: true,
    result: method === 'status.get' ? { capabilities } : result,
    _meta: { runtimeId: 'runtime-1' }
  }))
  const context: HandlerContext = {
    flags: new Map<string, string | boolean>([
      ['environment', 'build-box'],
      ...Object.entries(flags)
    ]),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers only use the client's call.
    client: { call } as unknown as RuntimeClient,
    cwd: '/tmp',
    json: false
  }
  const run = MANAGED_SERVER_HANDLERS['environment update']!(context)
  return {
    run,
    updateParams: () => call.mock.calls.find(([method]) => method === 'managedServer.update')?.[1]
  }
}

describe('orca environment update', () => {
  it('never sends plain --force to a desktop that would give it full force', async () => {
    const olderDesktop = { capabilities: [MANAGED_SERVER_RUNTIME_CAPABILITY] }
    const plain = updateWith({ force: true }, olderDesktop)
    await expect(plain.run).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(plain.updateParams()).toBeUndefined()
    // The explicit confirmation means the same on either desktop, so it is still sent.
    const confirmed = updateWith({ force: true, 'end-server-terminals': true }, olderDesktop)
    await expect(confirmed.run).rejects.toMatchObject({ code: 'managed_server_deferred' })
    expect(confirmed.updateParams()).toEqual({
      selector: 'build-box',
      force: true,
      endServerTerminals: true
    })
    const current = updateWith({ force: true })
    await expect(current.run).rejects.toMatchObject({ code: 'managed_server_deferred' })
    expect(current.updateParams()).toEqual({ selector: 'build-box', force: true })
  })
})

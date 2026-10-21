import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClientError } from '../runtime-client'
import { MACHINE_HANDLERS } from './machine'

const KEY = 'plugin:acme.omarchy/omarchy'
const SNAPSHOT = {
  providerKey: KEY,
  name: 'Omarchy box',
  machines: [
    {
      id: 'sbx-1',
      name: 'dev',
      lifetime: 'persistent',
      state: 'running',
      createdAt: '2026-10-18T00:00:00Z',
      providerKey: KEY,
      lastSeenAt: 1
    }
  ],
  pendingCreates: []
}

function envelope(result: unknown) {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

async function run(
  command: string,
  call: ReturnType<typeof vi.fn>,
  flags: [string, string | boolean][]
) {
  const handler = MACHINE_HANDLERS[command]
  if (!handler) {
    throw new Error(`no handler for ${command}`)
  }
  await handler({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers only call client.call.
    client: { call } as never,
    cwd: '/tmp',
    flags: new Map(flags),
    json: true
  })
}

afterEach(() => vi.restoreAllMocks())

describe('orca machine', () => {
  it('ls prints the cached inventory unless --refresh is passed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const call = vi.fn(async () => envelope({ ok: true, value: [SNAPSHOT] }))
    await run('machine ls', call, [['refresh', true]])
    expect(call).toHaveBeenCalledWith(
      'machines.list',
      { providerKey: undefined, refresh: true },
      undefined
    )
  })

  it('wake finds the provider from the cache and waits past the RPC default', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const call = vi.fn(async (method: string) =>
      method === 'machines.list'
        ? envelope({ ok: true, value: [SNAPSHOT] })
        : envelope({ ok: true, value: SNAPSHOT.machines[0] })
    )
    await run('machine wake', call, [['machine-id', 'sbx-1']])
    expect(call).toHaveBeenLastCalledWith(
      'machines.wake',
      { providerKey: KEY, machineId: 'sbx-1' },
      { timeoutMs: 300_000 }
    )
  })

  it('surfaces a provider failure with its code', async () => {
    const call = vi.fn(async () =>
      envelope({ ok: false, code: 'auth-required', message: 'Permission denied (publickey).' })
    )
    await expect(
      run('machine sleep', call, [
        ['machine-id', 'sbx-1'],
        ['provider', KEY]
      ])
    ).rejects.toMatchObject({ code: 'machine_auth-required' })
  })

  it('reads an older runtime’s method_not_found as unsupported', async () => {
    const call = vi.fn(async () => {
      throw new RuntimeClientError('method_not_found', 'Unknown method')
    })
    await expect(run('machine ls', call, [])).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
  })
})

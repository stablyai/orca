import { describe, expect, it } from 'vitest'
import { readMachineAction, readMachinesList } from './machine-replies'

const meta = { runtimeId: 'runtime-1' }
const provider = {
  providerKey: 'plugin:acme.omarchy/omarchy',
  name: 'Omarchy box',
  machines: [{ id: 'sbx-1', name: 'dev', lifetime: 'temporary', state: 'running', lastSeenAt: 1 }],
  pendingCreates: []
}
const ok = (result: unknown) => ({ id: 'r', ok: true as const, result, _meta: meta })
const refused = (code: string, message: string) => ({
  id: 'r',
  ok: false as const,
  error: { code, message },
  _meta: meta
})

describe('readMachinesList', () => {
  it('reads providers from a successful answer', () => {
    expect(readMachinesList(ok({ ok: true, value: [provider] }))).toMatchObject({
      kind: 'providers',
      providers: [{ name: 'Omarchy box', machines: [{ id: 'sbx-1' }] }]
    })
  })

  it('treats an older desktop and a desktop with Machines off as unavailable', () => {
    expect(readMachinesList(refused('method_not_found', 'Unknown method'))).toEqual({
      kind: 'unavailable'
    })
    expect(readMachinesList(ok({ ok: false, code: 'unsupported', message: 'off' }))).toEqual({
      kind: 'unavailable'
    })
  })

  it('reports other failures with their message', () => {
    expect(readMachinesList(ok({ ok: false, code: 'unavailable', message: 'No ssh' }))).toEqual({
      kind: 'failed',
      message: 'No ssh'
    })
  })
})

describe('readMachineAction', () => {
  it('returns the machine or the provider message', () => {
    expect(readMachineAction(ok({ ok: true, value: provider.machines[0] }), 'wake')).toMatchObject({
      kind: 'done',
      machine: { id: 'sbx-1' }
    })
    expect(
      readMachineAction(ok({ ok: false, code: 'auth-required', message: 'Sign in' }), 'sleep')
    ).toEqual({ kind: 'failed', message: 'Sign in' })
  })

  it('reads a transport failure as unverified and drops only unreadable rows', () => {
    expect(readMachineAction(refused('timeout', 'Request timed out'), 'wake')).toEqual({
      kind: 'unverified'
    })
    const partial = {
      ...provider,
      machines: [
        ...provider.machines,
        { id: 42 },
        { ...provider.machines[0], id: 'sbx-2', lastSeenAt: 'x' }
      ]
    }
    const read = readMachinesList(ok({ ok: true, value: [partial] }))
    expect(read.kind === 'providers' ? read.providers[0]?.machines.map((m) => m.id) : null).toEqual(
      ['sbx-1', 'sbx-2']
    )
  })
})

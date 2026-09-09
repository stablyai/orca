/**
 * Relay/runtime parity for the office surface.
 *
 * Three implementations of one contract is exactly the shape that drifts: a method added to the
 * runtime and forgotten on the relay produces a feature that works on a paired host and silently
 * does nothing over SSH. The method list is the contract, so it is what these tests compare against.
 */
import { describe, expect, it, vi } from 'vitest'
import { OFFICE_RPC_METHODS } from '../../shared/office-preview-rpc'
import { createOfficeMethods } from '../runtime/rpc/methods/office'
import { OfficeHandler } from '../../relay/office-handler'

describe('office surface parity', () => {
  it('registers every method on the SSH relay', () => {
    const onRequest = vi.fn()
    new OfficeHandler({ onRequest })
    const registered = onRequest.mock.calls.map((call) => call[0] as string)
    expect(new Set(registered)).toEqual(new Set(OFFICE_RPC_METHODS))
  })

  it('registers every method on a paired runtime', () => {
    const registered = createOfficeMethods().map((method) => method.name)
    expect(new Set(registered)).toEqual(new Set(OFFICE_RPC_METHODS))
  })

  it('validates params on the runtime, where a mixed-version client can send anything', () => {
    const byName = new Map(createOfficeMethods().map((method) => [method.name, method]))
    const render = byName.get('office.render')
    expect(render?.params?.safeParse({ path: '/w/a.docx' }).success).toBe(true)
    // A required path really is required, and an unknown key is a schema error rather than a
    // silently dropped field.
    expect(render?.params?.safeParse({}).success).toBe(false)
    expect(render?.params?.safeParse({ path: '/w/a.docx', extra: 1 }).success).toBe(false)

    const probe = byName.get('office.probe')
    expect(probe?.params?.safeParse({}).success).toBe(true)
    expect(probe?.params?.safeParse({ refresh: true }).success).toBe(true)

    const install = byName.get('office.skillsInstall')
    expect(
      install?.params?.safeParse({ pairs: [{ skill: 'pptx', agent: 'claude' }] }).success
    ).toBe(true)
    expect(install?.params?.safeParse({ pairs: [] }).success).toBe(false)
    expect(
      install?.params?.safeParse({ pairs: [{ skill: 'rm -rf /', agent: 'claude' }] }).success
    ).toBe(false)
  })
})

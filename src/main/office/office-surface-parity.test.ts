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
    // Sorted arrays rather than sets: a set hides a method registered twice, which is a real way
    // to break a dispatcher.
    expect([...registered].sort()).toEqual([...OFFICE_RPC_METHODS].sort())
  })

  it('registers every method on a paired runtime', () => {
    const registered = createOfficeMethods().map((method) => method.name)
    expect([...registered].sort()).toEqual([...OFFICE_RPC_METHODS].sort())
  })

  it('validates params on the runtime, where a mixed-version client can send anything', () => {
    const byName = new Map(createOfficeMethods().map((method) => [method.name, method]))
    const render = byName.get('office.render')
    expect(render?.params?.safeParse({ workspaceRoot: '/w', relativePath: 'a.docx' }).success).toBe(
      true
    )
    // Both halves are required, and an unknown key is a schema error rather than a silently
    // dropped field.
    expect(render?.params?.safeParse({}).success).toBe(false)
    expect(render?.params?.safeParse({ workspaceRoot: '/w' }).success).toBe(false)
    expect(
      render?.params?.safeParse({ workspaceRoot: '/w', relativePath: 'a.docx', extra: 1 }).success
    ).toBe(false)

    // The half that carries the boundary: an absolute path in `relativePath` would escape the
    // workspace the caller named, so the schema refuses it before the host ever canonicalises.
    for (const absolute of ['/etc/passwd', 'C:\\Windows\\x.docx', '\\\\host\\share\\x.docx']) {
      expect(
        render?.params?.safeParse({ workspaceRoot: '/w', relativePath: absolute }).success
      ).toBe(false)
    }

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

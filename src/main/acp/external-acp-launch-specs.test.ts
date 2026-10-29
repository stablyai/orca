import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readExternalAcpLaunchSpecs } from './external-acp-launch-specs'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'external-acp-'))
  roots.push(root)
  const path = join(root, 'agents.json')
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      agents: [{ agent: 'hermes', command: '/opt/hermes-acp', args: ['--stdio'] }]
    }),
    { mode: 0o600 }
  )
  return path
}
describe('external ACP host installation', () => {
  it('loads a private registration into the ordinary ACP contract', () => {
    const result = readExternalAcpLaunchSpecs(fixture(), ['codex'])
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.specs[0].agent).toBe('hermes')
    expect(result.specs[0].args({ fullAccess: false, pluginDir: null })).toEqual(['--stdio'])
    expect(result.specs[0].modelDiscovery.kind).toBe('unavailable')
  })
  it('leaves built-ins available without an opt-in file', () => {
    expect(readExternalAcpLaunchSpecs(undefined, [])).toEqual({ ok: true, specs: [] })
  })
  it.skipIf(process.platform === 'win32')(
    'rejects symlinks and group writable files on POSIX',
    () => {
      const path = fixture()
      const link = `${path}.link`
      symlinkSync(path, link)
      expect(readExternalAcpLaunchSpecs(link, []).ok).toBe(false)
      chmodSync(path, 0o660)
      expect(readExternalAcpLaunchSpecs(path, []).ok).toBe(false)
    }
  )
  it('changes the account identity when the endpoint changes', () => {
    const path = fixture()
    const before = readExternalAcpLaunchSpecs(path, [])
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        agents: [{ agent: 'hermes', command: '/different/agent', args: [] }]
      })
    )
    const after = readExternalAcpLaunchSpecs(path, [])
    expect(
      before.ok && after.ok && before.specs[0].account.pin !== after.specs[0].account.pin
    ).toBe(true)
    if (before.ok && after.ok) {
      expect(before.specs[0].account.pin).not.toEqual(after.specs[0].account.pin)
    }
  })
})

it('loads the host registration without an inherited desktop environment', () => {
  const result = readExternalAcpLaunchSpecs(undefined, [], fixture())
  expect(result.ok && result.specs[0]?.agent).toBe('hermes')
})
it('treats an absent default as no registration, but never falls back from an explicit path', () => {
  const path = fixture()
  expect(readExternalAcpLaunchSpecs(undefined, [], `${path}.missing`)).toEqual({
    ok: true,
    specs: []
  })
  expect(readExternalAcpLaunchSpecs(`${path}.missing`, [], path).ok).toBe(false)
})

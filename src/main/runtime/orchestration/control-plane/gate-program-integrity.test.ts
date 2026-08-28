import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintGateDependencies, hasUnprovableDependency } from './gate-dependency-fingerprint'

/** GATE_EXECUTABLE_WAS_UNVERIFIED — a required gate declared `program: 'pnpm'`
 *  and a `commandIdentity` label, and nothing ever bound the receipt to the
 *  BYTES PATH resolved. A shadowing impostor earlier on PATH ran instead and
 *  its PASS was indistinguishable from the real toolchain's.
 */
describe.skipIf(process.platform === 'win32')('GATE_EXECUTABLE_WAS_UNVERIFIED', () => {
  let root: string | undefined
  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true })
      root = undefined
    }
  })

  function pathWith(body: string): { dir: string; cwd: string } {
    root ??= mkdtempSync(join(tmpdir(), 'orca-gate-program-'))
    const dir = mkdtempSync(join(root, 'bin-'))
    const binary = join(dir, 'orca-fixture-gate')
    writeFileSync(binary, `#!/bin/sh\n${body}\n`)
    chmodSync(binary, 0o755)
    const cwd = join(root, 'tree')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'src.txt'), 'source')
    return { dir, cwd }
  }

  function fingerprint(dir: string, cwd: string): Record<string, string> {
    const previous = process.env.PATH
    process.env.PATH = `${dir}:${previous ?? ''}`
    try {
      return fingerprintGateDependencies({
        spec: { gateId: 'unit', files: ['src.txt'] },
        fallbackFiles: [],
        cwd,
        policyVersion: 'unit-v1',
        commandIdentity: 'orca-fixture-gate:v1',
        program: 'orca-fixture-gate'
      })
    } finally {
      process.env.PATH = previous
    }
  }

  it('separates a PATH impostor from the real gate binary under one identity', () => {
    const real = pathWith('exit 0')
    const impostor = pathWith('exit 0 # different bytes, same name and identity')

    const genuine = fingerprint(real.dir, real.cwd)
    const shadowed = fingerprint(impostor.dir, impostor.cwd)

    // Same gateId, same commandIdentity, same declared files — only the binary
    // differs, and that alone must break receipt reuse.
    expect(genuine['config:commandIdentity']).toBe(shadowed['config:commandIdentity'])
    expect(genuine).not.toEqual(shadowed)
    const programKey = Object.keys(genuine).find((key) => key.startsWith('program:'))
    expect(programKey).toBeDefined()
    expect(hasUnprovableDependency(genuine)).toBeNull()
  })

  it('refuses a gate whose declared program is not on PATH at all', () => {
    const real = pathWith('exit 0')
    const hashes = fingerprintGateDependencies({
      spec: { gateId: 'unit', files: ['src.txt'] },
      fallbackFiles: [],
      cwd: real.cwd,
      policyVersion: 'unit-v1',
      commandIdentity: 'missing:v1',
      program: 'orca-gate-that-does-not-exist'
    })
    expect(hasUnprovableDependency(hashes)).toBe('program:orca-gate-that-does-not-exist')
  })
})

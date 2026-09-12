import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadOrCreateRuntimeIdentity } from './runtime-identity'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-runtime-identity-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('loadOrCreateRuntimeIdentity', () => {
  it('persists one identity and returns it after restart', () => {
    const path = join(directory, 'runtime-identity.json')
    const first = loadOrCreateRuntimeIdentity(path)
    const second = loadOrCreateRuntimeIdentity(path)

    expect(first).toBe(second)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      runtimeId: first
    })
  })

  it('fails closed on malformed or oversized state', () => {
    const path = join(directory, 'runtime-identity.json')
    writeFileSync(path, JSON.stringify({ version: 1, runtimeId: '' }))
    expect(() => loadOrCreateRuntimeIdentity(path)).toThrow('runtime_identity_invalid')

    writeFileSync(path, JSON.stringify({ version: 2, runtimeId: 'runtime' }))
    expect(() => loadOrCreateRuntimeIdentity(path)).toThrow('runtime_identity_invalid')
  })
})

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RuntimePtySourceAuthorityFileStore } from './runtime-pty-source-authority-file-store'
import {
  RuntimePtySourceAuthorityRegistry,
  type RuntimePtySourceAuthorityStore
} from './runtime-pty-source-authority-registry'

let directory: string
let path: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-runtime-pty-authority-'))
  path = join(directory, 'authorities.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function processInfo(id: string, incarnationId?: string) {
  return { id, cwd: '/workspace', title: 'shell', ...(incarnationId ? { incarnationId } : {}) }
}

function registry(maxRecords?: number): RuntimePtySourceAuthorityRegistry {
  let lease = 0
  return new RuntimePtySourceAuthorityRegistry({
    store: new RuntimePtySourceAuthorityFileStore(path),
    ...(maxRecords === undefined ? {} : { maxRecords }),
    mintOwnerLease: () => `lease-${++lease}`
  })
}

describe('RuntimePtySourceAuthorityRegistry', () => {
  it('restores an exact authority only after the current provider proves its incarnation', () => {
    const first = registry()
    const authority = first.admit('pty-1', 'incarnation-1')

    const restored = registry()
    expect(restored.resolve('pty-1')).toBeNull()
    expect(restored.reconcile([processInfo('pty-1', 'incarnation-1')])).toEqual([authority])
    expect(restored.resolve('pty-1')).toEqual(authority)

    restored.deactivateAll()
    expect(restored.resolve('pty-1')).toBeNull()
  })

  it('rotates lease and generation when an exact terminal ID changes incarnation', () => {
    const source = registry()
    const first = source.admit('pty-1', 'incarnation-1')
    const replacement = source.reconcile([processInfo('pty-1', 'incarnation-2')])[0]!

    expect(replacement).toMatchObject({
      terminalId: 'pty-1',
      incarnationId: 'incarnation-2',
      sourceOwnerGeneration: 2
    })
    expect(replacement.ownerLease).not.toBe(first.ownerLease)
    expect(source.resolve('pty-1')).toEqual(replacement)
  })

  it('keeps a persisted record inactive when inventory cannot prove its incarnation', () => {
    const source = registry()
    const authority = source.admit('pty-1', 'incarnation-1')

    expect(source.reconcile([processInfo('pty-1')])).toEqual([])
    expect(source.resolve('pty-1')).toBeNull()
    expect(source.reconcile([processInfo('pty-1', 'incarnation-1')])).toEqual([authority])
  })

  it('bounds retained records and frees capacity only after exact exit or absence', () => {
    const source = registry(2)
    source.admit('pty-1', 'incarnation-1')
    source.admit('pty-2', 'incarnation-2')
    expect(() => source.admit('pty-3', 'incarnation-3')).toThrow(
      'runtime_pty_source_authority_capacity_exceeded'
    )
    expect(source.retire('pty-1', 'wrong-incarnation')).toBe(false)
    expect(() => source.admit('pty-3', 'incarnation-3')).toThrow(
      'runtime_pty_source_authority_capacity_exceeded'
    )

    expect(source.retire('pty-1', 'incarnation-1')).toBe(true)
    expect(source.admit('pty-3', 'incarnation-3')).toMatchObject({ terminalId: 'pty-3' })
    expect(JSON.parse(readFileSync(path, 'utf8')).records).toHaveLength(2)
  })

  it('fails closed on ambiguous inventory without changing durable records', () => {
    const source = registry()
    const authority = source.admit('pty-1', 'incarnation-1')

    expect(() =>
      source.reconcile([
        processInfo('pty-1', 'incarnation-1'),
        processInfo('pty-1', 'incarnation-1')
      ])
    ).toThrow('runtime_pty_source_authority_inventory_ambiguous')
    expect(source.resolve('pty-1')).toEqual(authority)
    expect(registry().reconcile([processInfo('pty-1', 'incarnation-1')])).toEqual([authority])
  })

  it('does not publish in-memory authority when its durable write fails', () => {
    const store: RuntimePtySourceAuthorityStore = {
      loadAll: () => [],
      replaceAll: () => {
        throw new Error('disk-full')
      }
    }
    const source = new RuntimePtySourceAuthorityRegistry({ store })

    expect(() => source.admit('pty-1', 'incarnation-1')).toThrow('disk-full')
    expect(source.resolve('pty-1')).toBeNull()
  })

  it('rejects malformed durable state', () => {
    writeFileSync(path, JSON.stringify({ version: 1, records: [{ version: 1 }] }))
    expect(() => registry()).toThrow('runtime_pty_source_authority_registry_invalid')
  })

  it('rejects non-string inventory identities with the registry error', () => {
    const source = registry()
    expect(() => source.reconcile([{ id: 42 as never, cwd: '', title: '' }])).toThrow(
      'runtime_pty_source_authority_registry_invalid'
    )
  })
})

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const { BrowserExtensionInstallStore } = await import('./browser-extension-install-store')

const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const ID_C = 'cccccccccccccccccccccccccccccccc'

function record(id: string) {
  return {
    id,
    name: id.slice(0, 3),
    version: '1.0',
    path: `/ext/${id}`,
    source: 'unpacked' as const,
    iconPath: null,
    permissions: [],
    hostPermissions: [],
    optionsPage: null
  }
}

function storeDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'orca-extension-store-'))
}

function isExtensionRecord(value: unknown): value is { id: string } {
  return (
    typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
  )
}

function savedExtensionIds(path: string): string[] {
  const saved: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(saved)) {
    throw new Error('installed.json is not a list')
  }
  return saved.filter(isExtensionRecord).map((entry) => entry.id)
}

describe('browser extension install store', () => {
  it('keeps an unreadable installed list instead of replacing it with the next save', () => {
    const directory = storeDirectory()
    const truncated = '[{"id":"aaaa'
    writeFileSync(join(directory, 'installed.json'), truncated)

    const store = new BrowserExtensionInstallStore(directory)
    expect(store.list()).toEqual([])
    expect(() => store.save(record(ID_C))).toThrow(/could not be read/)
    expect(readFileSync(join(directory, 'installed.json'), 'utf8')).toBe(truncated)
  })

  it('saves normally when the installed list is readable', () => {
    const directory = storeDirectory()
    writeFileSync(join(directory, 'installed.json'), JSON.stringify([record(ID_A), record(ID_B)]))

    const store = new BrowserExtensionInstallStore(directory)
    store.save(record(ID_C))

    expect(savedExtensionIds(join(directory, 'installed.json'))).toEqual([ID_A, ID_B, ID_C])
  })
})

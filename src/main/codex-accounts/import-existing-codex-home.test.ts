import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertSourceHomeIsNotManagedStorage,
  copyExistingCodexHomeIntoManaged,
  readRawAuthJsonFromHome,
  resolveImportableCodexHomePath
} from './import-existing-codex-home'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-import-codex-home-'))
  roots.push(root)
  return root
}

describe('import-existing-codex-home', () => {
  it('resolves a directory that has auth.json', () => {
    const root = makeRoot()
    const home = join(root, '.codex-work')
    mkdirSync(home)
    writeFileSync(join(home, 'auth.json'), '{"tokens":{}}', 'utf-8')

    expect(resolveImportableCodexHomePath(home)).toBe(home)
  })

  it('rejects missing auth.json', () => {
    const root = makeRoot()
    const home = join(root, 'empty')
    mkdirSync(home)

    expect(() => resolveImportableCodexHomePath(home)).toThrow(/missing auth\.json/)
  })

  it('rejects paths inside managed storage', () => {
    const root = makeRoot()
    const managedRoot = join(root, 'codex-accounts')
    const nested = join(managedRoot, 'account-1', 'home')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'auth.json'), '{}', 'utf-8')

    expect(() => assertSourceHomeIsNotManagedStorage(nested, managedRoot)).toThrow(
      /already inside Orca managed/
    )
  })

  it('copies home contents and rewrites the Orca ownership marker', () => {
    const root = makeRoot()
    const source = join(root, 'source')
    const managed = join(root, 'managed')
    mkdirSync(source)
    mkdirSync(managed)
    writeFileSync(join(source, 'auth.json'), '{"tokens":{"id_token":"x"}}', 'utf-8')
    writeFileSync(join(source, 'config.toml'), 'sandbox_mode = "workspace-write"\n', 'utf-8')
    writeFileSync(join(source, '.orca-managed-home'), 'other-id\n', 'utf-8')
    writeFileSync(join(managed, '.orca-managed-home'), 'account-import\n', 'utf-8')
    mkdirSync(join(source, 'sessions'))
    writeFileSync(join(source, 'sessions', 'a.jsonl'), 'session\n', 'utf-8')

    copyExistingCodexHomeIntoManaged({
      sourceHomePath: source,
      managedHomePath: managed,
      accountId: 'account-import'
    })

    expect(readFileSync(join(managed, 'auth.json'), 'utf-8')).toContain('id_token')
    expect(readFileSync(join(managed, 'config.toml'), 'utf-8')).toContain('workspace-write')
    expect(readFileSync(join(managed, 'sessions', 'a.jsonl'), 'utf-8')).toBe('session\n')
    expect(readFileSync(join(managed, '.orca-managed-home'), 'utf-8')).toBe('account-import\n')
    expect(existsSync(join(source, 'auth.json'))).toBe(true)
  })

  it('parses auth.json without leaking parse errors for corrupt files', () => {
    const root = makeRoot()
    const home = join(root, 'home')
    mkdirSync(home)
    writeFileSync(join(home, 'auth.json'), '{not-json', 'utf-8')

    expect(() => readRawAuthJsonFromHome(home)).toThrow(/corrupt or not valid JSON/)
  })
})

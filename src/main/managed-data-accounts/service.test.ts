import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type * as fileSystem from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedDataAccountService } from './service'

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fileSystem>())
}))

let root: string
let source: string
let service: ManagedDataAccountService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-data-accounts-test-'))
  source = join(root, 'source')
  mkdirSync(join(source, 'devin'), { recursive: true })
  writeFileSync(join(source, 'devin', 'credentials.toml'), 'windsurf_api_key = "test-only-key"\n')
  service = new ManagedDataAccountService(join(root, 'managed'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('managed data accounts', () => {
  it('serializes overlapping enrollment so neither account is lost', async () => {
    await Promise.all([service.add('devin', source, 'One'), service.add('devin', source, 'Two')])
    expect(service.list('devin').accounts.map((account) => account.label)).toEqual(['One', 'Two'])
  })
})

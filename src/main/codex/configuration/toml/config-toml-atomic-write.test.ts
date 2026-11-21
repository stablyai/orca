import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as WindowsRetryFileOperations from '../../../../shared/file-write/windows-retry-file-operations'
import { writeTomlConfigAtomically } from './config-toml-atomic-write'

const afterCopy = vi.hoisted(() => {
  const state: { run: (() => void) | null } = { run: null }
  return state
})

vi.mock('../../../../shared/file-write/windows-retry-file-operations', async (importOriginal) => {
  const actual = await importOriginal<typeof WindowsRetryFileOperations>()
  return {
    ...actual,
    copyFileWithWindowsRetry: (source: string, target: string) => {
      actual.copyFileWithWindowsRetry(source, target)
      const run = afterCopy.run
      afterCopy.run = null
      run?.()
    }
  }
})

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'orca-toml-atomic-write-test-'))
})

afterEach(() => {
  afterCopy.run = null
  rmSync(tmpDir, { recursive: true, force: true })
})

it('keeps the previous backup when a save lands while the backup is being copied', () => {
  const configPath = join(tmpDir, 'config.toml')
  writeFileSync(configPath, 'model = "a"\n', 'utf-8')
  writeFileSync(`${configPath}.bak`, 'model = "previous"\n', 'utf-8')
  afterCopy.run = () => writeFileSync(configPath, 'model = "b"\n', 'utf-8')

  expect(writeTomlConfigAtomically(configPath, 'model = "c"\n', 'model = "a"\n')).toBe(false)

  expect(readFileSync(configPath, 'utf-8')).toBe('model = "b"\n')
  expect(readFileSync(`${configPath}.bak`, 'utf-8')).toBe('model = "previous"\n')
})

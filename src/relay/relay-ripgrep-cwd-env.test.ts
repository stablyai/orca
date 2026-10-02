import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listFilesWithRg } from './fs-handler-list-files'
import { searchWithRg } from './fs-handler-utils'
import { configureRelayBundledRipgrep } from './relay-bundled-ripgrep'

describe.runIf(process.platform !== 'win32')(
  'relay ripgrep launch classification environment',
  () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'relay-rg-cwd-env-'))
      writeFileSync(join(dir, 'found.txt'), 'needle')
      const cargo = join(dir, 'cargo')
      mkdirSync(join(cargo, 'bin'), { recursive: true })
      writeFileSync(join(cargo, 'bin', 'rg'), '#!/bin/sh\necho found.txt\n', { mode: 0o755 })
      vi.stubEnv('PATH', join(dir, 'empty-path'))
      vi.stubEnv('CARGO_HOME', cargo)
      configureRelayBundledRipgrep(undefined)
    })

    afterEach(() => {
      vi.unstubAllEnvs()
      configureRelayBundledRipgrep(undefined)
      rmSync(dir, { recursive: true, force: true })
    })

    it('uses the search PATH to distinguish a moved root from missing ripgrep', async () => {
      await expect(listFilesWithRg(dir, [], { maxResults: 10 })).resolves.toContain('found.txt')
      const missing = join(dir, 'moved-root')
      await expect(listFilesWithRg(missing)).rejects.toThrow(
        `Search root is not reachable: ${missing}`
      )
      await expect(searchWithRg(missing, 'needle', { maxResults: 10 })).rejects.toThrow(
        `Search root is not reachable: ${missing}`
      )
    })
  }
)

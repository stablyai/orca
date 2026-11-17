import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolvePathServeSimExecutable } from './serve-sim-execution'

afterEach(() => vi.unstubAllEnvs())

describe.skipIf(process.platform === 'win32')('PATH serve-sim', () => {
  it('finds the middleware next to the resolved CLI entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-path-serve-sim-'))
    const bin = join(root, 'bin')
    const dist = join(root, 'package', 'dist')
    try {
      mkdirSync(bin)
      mkdirSync(dist, { recursive: true })
      const entry = join(dist, 'serve-sim.js')
      writeFileSync(entry, '')
      chmodSync(entry, 0o755)
      writeFileSync(join(dist, 'middleware.js'), '')
      symlinkSync(entry, join(bin, 'serve-sim'))
      vi.stubEnv('PATH', bin)
      expect(resolvePathServeSimExecutable()).toEqual({
        command: process.execPath,
        baseArgs: [realpathSync(entry)],
        usesElectronAsNode: true
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

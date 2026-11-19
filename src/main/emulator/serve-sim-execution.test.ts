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
  it.each(['symlink', 'pnpm shim'])('finds middleware from a %s', (kind) => {
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
      if (kind === 'symlink') {
        symlinkSync(entry, join(bin, 'serve-sim'))
      } else {
        writeFileSync(join(bin, 'serve-sim'), `#!/bin/sh\n# cmd-shim-target=${entry}\n`, {
          mode: 0o755
        })
      }
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

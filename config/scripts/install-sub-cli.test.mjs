import { lstatSync, mkdtempSync, mkdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { installSubCli } from './install-sub-cli.mjs'

describe.skipIf(process.platform === 'win32')('installSubCli', () => {
  it('creates a user-local orca-sub symlink to the wrapper and makes the wrapper executable', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-sub-install-'))
    const installDir = path.join(root, 'bin')
    const source = path.join(root, 'orca-sub.mjs')
    writeFileSync(source, '#!/usr/bin/env node\n', { mode: 0o644 })

    const result = installSubCli({ source, installDir })
    const commandPath = path.join(installDir, 'orca-sub')

    expect(result).toEqual({ status: 'installed', commandPath })
    expect(lstatSync(commandPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(commandPath)).toBe(source)
    expect(lstatSync(source).mode & 0o111).not.toBe(0)
  })

  it('is idempotent for our existing symlink', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-sub-install-'))
    const installDir = path.join(root, 'bin')
    const source = path.join(root, 'orca-sub.mjs')
    writeFileSync(source, '#!/usr/bin/env node\n')

    installSubCli({ source, installDir })
    expect(installSubCli({ source, installDir })).toEqual({
      status: 'already-installed',
      commandPath: path.join(installDir, 'orca-sub')
    })
  })

  it('does not overwrite an unrelated existing command', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-sub-install-'))
    const installDir = path.join(root, 'bin')
    const source = path.join(root, 'orca-sub.mjs')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(source, '#!/usr/bin/env node\n')
    const commandPath = path.join(installDir, 'orca-sub')
    writeFileSync(commandPath, 'existing command')

    expect(installSubCli({ source, installDir })).toEqual({
      status: 'conflict',
      commandPath
    })
  })
})

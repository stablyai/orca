import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_CONFIG_FILE_MODE, enforceCodexConfigFileMode } from './codex-config-file-mode'

let dir: string
const modeOf = (path: string): string => (statSync(path).mode & 0o777).toString(8)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-codex-mode-unit-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('enforceCodexConfigFileMode', () => {
  it('repairs a symlinked config through its realpath, and that file’s backup', () => {
    const real = join(dir, 'dotfiles-config.toml')
    const link = join(dir, 'config.toml')
    writeFileSync(real, 'model = "x"\n', 'utf-8')
    writeFileSync(`${real}.bak`, 'model = "x"\n', 'utf-8')
    chmodSync(real, 0o644)
    chmodSync(`${real}.bak`, 0o644)
    symlinkSync(real, link)

    enforceCodexConfigFileMode(link)

    // The writer backs a symlinked config up to <realpath>.bak, so the repair
    // has to resolve the same way or it chmods a file that does not exist.
    expect(modeOf(real)).toBe('600')
    expect(modeOf(`${real}.bak`)).toBe('600')
  })

  it('stays silent for a config that is simply absent', () => {
    const warnings: string[] = []

    enforceCodexConfigFileMode(join(dir, 'missing.toml'), (message) => warnings.push(message))

    expect(warnings).toEqual([])
  })

  it('leaves an already-restricted file alone', () => {
    const path = join(dir, 'config.toml')
    writeFileSync(path, 'model = "x"\n', 'utf-8')
    chmodSync(path, CODEX_CONFIG_FILE_MODE)

    enforceCodexConfigFileMode(path)

    expect(modeOf(path)).toBe('600')
  })
})

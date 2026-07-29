import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCodexMicroSidecarPath } from './sidecar-path'

describe('resolveCodexMicroSidecarPath', () => {
  it('accepts only an explicit development override to an executable file', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-micro-path-'))
    const binary = join(root, process.platform === 'win32' ? 'codex-micro.exe' : 'codex-micro')
    writeFileSync(binary, 'binary')
    if (process.platform !== 'win32') {
      chmodSync(binary, 0o755)
    }

    expect(resolveCodexMicroSidecarPath({ allowOverride: true, override: binary })).toBe(binary)
    expect(resolveCodexMicroSidecarPath({ allowOverride: false, override: binary })).not.toBe(
      binary
    )
  })

  it('rejects relative, directory, and non-executable overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-micro-path-'))
    const plain = join(root, 'plain')
    const directory = join(root, 'directory')
    writeFileSync(plain, 'binary')
    mkdirSync(directory)

    expect(resolveCodexMicroSidecarPath({ allowOverride: true, override: 'relative' })).not.toBe(
      'relative'
    )
    expect(resolveCodexMicroSidecarPath({ allowOverride: true, override: directory })).not.toBe(
      directory
    )
    if (process.platform !== 'win32') {
      expect(resolveCodexMicroSidecarPath({ allowOverride: true, override: plain })).not.toBe(plain)
    }
  })

  it('never falls back to checkout-relative binaries in a packaged app', () => {
    const resourcesPath = mkdtempSync(join(tmpdir(), 'codex-micro-packaged-'))
    expect(
      resolveCodexMicroSidecarPath({
        packaged: true,
        resourcesPath,
        allowOverride: false
      })
    ).toBeNull()
  })
})

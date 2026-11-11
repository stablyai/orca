import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  EMBEDDED_RECEIPT_SUFFIX,
  relayNsisUninstaller,
  signWindowsUninstallerViaSignPath
} = require('./windows-uninstaller-signing.cjs')

const makeDir = () => mkdtempSync(join(tmpdir(), 'orca-uninstaller-signing-'))

describe('relayNsisUninstaller', () => {
  const writeUninstaller = (dir, contents) => {
    const filePath = join(dir, 'orca-windows-setup.__uninstaller.exe')
    writeFileSync(filePath, contents)
    return filePath
  }

  // Receipt is only evidence for embedded compressed NSIS uninstaller; bundled 7za cannot extract it.

  // Import signed bytes even when rebuild regenerated unsigned intermediate.
  it('prefers importing over exporting when both are configured', () => {
    const dir = makeDir()
    const filePath = writeUninstaller(dir, 'rebuild-unsigned')
    const signedPath = join(dir, 'signed', 'orca-uninstaller.exe')
    mkdirSync(join(dir, 'signed'))
    writeFileSync(signedPath, 'signpath-signed')

    expect(
      relayNsisUninstaller({ filePath, signedPath, exportPath: join(dir, 'out', 'x.exe') })
    ).toBe('imported')
    expect(readFileSync(filePath, 'utf8')).toBe('signpath-signed')
  })

  // Missing/unwritable relay must preserve unsigned build without throwing.
  it('leaves the unsigned uninstaller in place when no signed copy came back', () => {
    const dir = makeDir()
    const filePath = writeUninstaller(dir, 'unsigned-uninstaller')

    expect(
      relayNsisUninstaller({ filePath, signedPath: join(dir, 'absent', 'orca-uninstaller.exe') })
    ).toBe('signed-missing')
    expect(readFileSync(filePath, 'utf8')).toBe('unsigned-uninstaller')
  })
})

// Exercise actual hook’s fail-open behavior: Windows build has no continue-on-error and throwing prevents any SignPath request.
describe('signWindowsUninstallerViaSignPath', () => {
  const RELAY_VARS = ['ORCA_WIN_UNINSTALLER_EXPORT_PATH', 'ORCA_WIN_UNINSTALLER_SIGNED_PATH']

  const withEnv = (env, run) => {
    const saved = Object.fromEntries(RELAY_VARS.map((key) => [key, process.env[key]]))
    const apply = (values) => {
      for (const key of RELAY_VARS) {
        if (values[key] === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = values[key]
        }
      }
    }
    apply({ ...Object.fromEntries(RELAY_VARS.map((key) => [key, undefined])), ...env })
    try {
      return run()
    } finally {
      apply(saved)
    }
  }

  const writeBuiltUninstaller = (dir) => {
    const filePath = join(dir, 'orca-windows-setup.__uninstaller.exe')
    writeFileSync(filePath, 'built-by-makensis')
    return filePath
  }

  // Run both signing-hash passes over same file as electron-builder does.
  it('is idempotent across the sha1 and sha256 invocations on both legs', () => {
    const dir = makeDir()
    const filePath = writeBuiltUninstaller(dir)
    const exportPath = join(dir, 'relay', 'unsigned', 'orca-uninstaller.exe')

    withEnv({ ORCA_WIN_UNINSTALLER_EXPORT_PATH: exportPath }, () => {
      signWindowsUninstallerViaSignPath({ path: filePath })
      signWindowsUninstallerViaSignPath({ path: filePath })
    })
    expect(readFileSync(exportPath, 'utf8')).toBe('built-by-makensis')

    const signedPath = join(dir, 'relay', 'signed', 'orca-uninstaller.exe')
    mkdirSync(join(dir, 'relay', 'signed'), { recursive: true })
    writeFileSync(signedPath, 'signpath-signed')

    withEnv({ ORCA_WIN_UNINSTALLER_SIGNED_PATH: signedPath }, () => {
      signWindowsUninstallerViaSignPath({ path: filePath })
      signWindowsUninstallerViaSignPath({ path: filePath })
    })
    expect(readFileSync(filePath, 'utf8')).toBe('signpath-signed')
    expect(readFileSync(`${signedPath}${EMBEDDED_RECEIPT_SUFFIX}`, 'utf8')).toBe(
      createHash('sha256').update('signpath-signed').digest('hex')
    )
  })

  // Unwritable destination may cost signature, never release job.
  it('never throws when the export destination cannot be created', () => {
    const dir = makeDir()
    const filePath = writeBuiltUninstaller(dir)
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')

    withEnv({ ORCA_WIN_UNINSTALLER_EXPORT_PATH: join(blocker, 'sub', 'x.exe') }, () => {
      expect(() => signWindowsUninstallerViaSignPath({ path: filePath })).not.toThrow()
    })
    expect(readFileSync(filePath, 'utf8')).toBe('built-by-makensis')
  })
})

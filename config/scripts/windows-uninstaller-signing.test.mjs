import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  EMBEDDED_RECEIPT_SUFFIX,
  isNsisUninstallerArtifact,
  relayNsisUninstaller,
  signWindowsUninstallerViaSignPath
} = require('./windows-uninstaller-signing.cjs')

const makeDir = () => mkdtempSync(join(tmpdir(), 'orca-uninstaller-signing-'))

describe('isNsisUninstallerArtifact', () => {
  // The name app-builder-lib's NsisTarget.computeScriptAndSignUninstaller gives
  // the intermediate uninstaller; the hook keys off nothing else.
  it('matches only electron-builder intermediate uninstallers', () => {
    expect(isNsisUninstallerArtifact('C:\\dist\\orca-windows-setup.__uninstaller.exe')).toBe(true)
    expect(isNsisUninstallerArtifact('/dist/orca-windows-setup.__uninstaller.exe')).toBe(true)
    expect(isNsisUninstallerArtifact('C:\\dist\\win-unpacked\\Orca.exe')).toBe(false)
    expect(isNsisUninstallerArtifact('C:\\dist\\orca-windows-setup.exe')).toBe(false)
    expect(isNsisUninstallerArtifact(undefined)).toBe(false)
  })
})

describe('relayNsisUninstaller', () => {
  const writeUninstaller = (dir, contents) => {
    const filePath = join(dir, 'orca-windows-setup.__uninstaller.exe')
    writeFileSync(filePath, contents)
    return filePath
  }

  it('ignores every file that is not the uninstaller', () => {
    const dir = makeDir()
    const filePath = join(dir, 'Orca.exe')
    writeFileSync(filePath, 'app')
    expect(relayNsisUninstaller({ filePath, exportPath: join(dir, 'out', 'x.exe') })).toBe(
      'not-uninstaller'
    )
  })

  it('exports the unsigned uninstaller, creating the destination directory', () => {
    const dir = makeDir()
    const filePath = writeUninstaller(dir, 'unsigned-uninstaller')
    const exportPath = join(dir, 'uninstaller-signing', 'unsigned', 'orca-uninstaller.exe')

    expect(relayNsisUninstaller({ filePath, exportPath })).toBe('exported')
    expect(readFileSync(exportPath, 'utf8')).toBe('unsigned-uninstaller')
  })

  it('overwrites the freshly built uninstaller with the signed bytes', () => {
    const dir = makeDir()
    const filePath = writeUninstaller(dir, 'rebuild-unsigned')
    const signedPath = join(dir, 'signed', 'orca-uninstaller.exe')
    mkdirSync(join(dir, 'signed'))
    writeFileSync(signedPath, 'signpath-signed')

    expect(relayNsisUninstaller({ filePath, signedPath })).toBe('imported')
    expect(readFileSync(filePath, 'utf8')).toBe('signpath-signed')
  })

  // The receipt is the evidence gate's only handle on the embedded uninstaller:
  // NSIS hides it in a compressed section the bundled 7za cannot read.
  it('records the digest of the bytes it handed makensis', () => {
    const dir = makeDir()
    const filePath = writeUninstaller(dir, 'rebuild-unsigned')
    const signedPath = join(dir, 'signed', 'orca-uninstaller.exe')
    mkdirSync(join(dir, 'signed'))
    writeFileSync(signedPath, 'signpath-signed')

    relayNsisUninstaller({ filePath, signedPath })

    const expected = createHash('sha256').update('signpath-signed').digest('hex')
    expect(readFileSync(`${signedPath}${EMBEDDED_RECEIPT_SUFFIX}`, 'utf8')).toBe(expected)
  })

  it('leaves no receipt when the signed uninstaller never came back', () => {
    const dir = makeDir()
    const filePath = writeUninstaller(dir, 'unsigned-uninstaller')
    const signedPath = join(dir, 'absent', 'orca-uninstaller.exe')

    relayNsisUninstaller({ filePath, signedPath })

    expect(existsSync(`${signedPath}${EMBEDDED_RECEIPT_SUFFIX}`)).toBe(false)
  })

  // Import wins so the rebuild pass embeds the signed bytes even though it also
  // regenerates an unsigned uninstaller of its own.
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

  // Fail-open: a missing or unwritable relay must leave the build with today's
  // unsigned uninstaller, never throw.
  it('leaves the unsigned uninstaller in place when no signed copy came back', () => {
    const dir = makeDir()
    const filePath = writeUninstaller(dir, 'unsigned-uninstaller')

    expect(
      relayNsisUninstaller({ filePath, signedPath: join(dir, 'absent', 'orca-uninstaller.exe') })
    ).toBe('signed-missing')
    expect(readFileSync(filePath, 'utf8')).toBe('unsigned-uninstaller')
  })

  it('swallows filesystem errors instead of failing the build', () => {
    const dir = makeDir()
    const filePath = writeUninstaller(dir, 'unsigned-uninstaller')
    const fs = {
      existsSync: () => true,
      mkdirSync: () => {},
      copyFileSync: () => {
        throw new Error('EACCES')
      }
    }

    expect(relayNsisUninstaller({ filePath, exportPath: join(dir, 'x.exe'), fs })).toBe(
      'failed: EACCES'
    )
  })

  it('does nothing when neither relay path is configured (local builds)', () => {
    const dir = makeDir()
    const filePath = writeUninstaller(dir, 'unsigned-uninstaller')

    expect(relayNsisUninstaller({ filePath })).toBe('idle')
    expect(readFileSync(filePath, 'utf8')).toBe('unsigned-uninstaller')
  })
})

// Why a suite of its own: this is the function electron-builder actually calls,
// and it runs inside `Build Windows release artifacts`, which has no
// continue-on-error. If it throws, the release job dies before a single
// SignPath request is made. Nothing else in the chain guards that.
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

  it.each([
    ['a missing configuration', undefined],
    ['a configuration with no path', {}],
    ['a non-uninstaller path', { path: 'C:\\dist\\win-unpacked\\Orca.exe' }]
  ])('never throws on %s', (_label, configuration) => {
    withEnv({ ORCA_WIN_UNINSTALLER_EXPORT_PATH: join(makeDir(), 'out', 'x.exe') }, () => {
      expect(() => signWindowsUninstallerViaSignPath(configuration)).not.toThrow()
    })
  })

  // electron-builder calls the hook once per signing hash (sha1 then sha256),
  // so both legs have to survive running twice over the same file.
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

  // An unwritable destination is the realistic filesystem failure, and it must
  // cost the uninstaller signature rather than the release job.
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

  it('does nothing when neither relay variable is set (local Windows builds)', () => {
    const dir = makeDir()
    const filePath = writeBuiltUninstaller(dir)

    withEnv({}, () => {
      expect(() => signWindowsUninstallerViaSignPath({ path: filePath })).not.toThrow()
    })
    expect(readFileSync(filePath, 'utf8')).toBe('built-by-makensis')
  })
})

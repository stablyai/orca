import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  findSignatureOffenders,
  isWindowsPayloadBinary,
  listWindowsPayloadBinaries,
  main,
  parseArgs,
  verifyWindowsPayloadSignatures
} from './verify-windows-payload-signatures.mjs'

const SIGNPATH = 'CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US'
const MICROSOFT = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'

function makePayload(files) {
  const root = mkdtempSync(join(tmpdir(), 'orca-payload-'))
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  return root
}

// Answers like the PowerShell script, reading the file list it was handed.
function fakePowerShell(signerFor) {
  return vi.fn((_command, _args, options) => {
    const paths = readFileSync(options.env.ORCA_WINDOWS_SIGNATURE_LIST, 'utf8').split('\n')
    const rows = paths.map((path) => {
      const subject = signerFor(path)
      return { path, status: subject ? 'Valid' : 'NotSigned', signerSubject: subject }
    })
    return { status: 0, stdout: JSON.stringify(rows), stderr: '' }
  })
}

describe('isWindowsPayloadBinary', () => {
  it('keeps Windows binaries, including the Windows orcad template target', () => {
    expect(isWindowsPayloadBinary('Orca.exe')).toBe(true)
    expect(isWindowsPayloadBinary('ffmpeg.DLL')).toBe(true)
    expect(
      isWindowsPayloadBinary('resources/node_modules/node-pty/build/Release/conpty.node')
    ).toBe(true)
    expect(
      isWindowsPayloadBinary(
        'resources/orcad-template/targets/win32-x64/node_modules/node-pty/build/Release/pty.node'
      )
    ).toBe(true)
  })

  it('skips non-binaries and non-Windows orcad template payloads', () => {
    expect(isWindowsPayloadBinary('resources/app.asar')).toBe(false)
    expect(isWindowsPayloadBinary('resources/node_modules/node-pty/lib/index.js')).toBe(false)
    expect(
      isWindowsPayloadBinary(
        'resources/orcad-template/targets/linux-x64-glibc/node_modules/node-pty/build/Release/pty.node'
      )
    ).toBe(false)
    expect(
      isWindowsPayloadBinary(
        'resources/orcad-template/targets/darwin-arm64/node_modules/@parcel/watcher/watcher.node'
      )
    ).toBe(false)
  })
})

describe('listWindowsPayloadBinaries', () => {
  it('walks the whole tree with forward-slash relative paths', () => {
    const root = makePayload([
      'Orca.exe',
      'resources/app.asar',
      'resources/node_modules/node-pty/build/Release/conpty.node',
      'resources/orcad-template/targets/linux-x64-musl/node_modules/node-pty/build/Release/pty.node'
    ])
    expect(listWindowsPayloadBinaries(root)).toEqual([
      'Orca.exe',
      'resources/node_modules/node-pty/build/Release/conpty.node'
    ])
  })
})

describe('findSignatureOffenders', () => {
  it('accepts the expected signer and Microsoft vendor signatures only when valid', () => {
    const offenders = findSignatureOffenders(
      [
        { path: 'Orca.exe', status: 'Valid', signerSubject: SIGNPATH },
        { path: 'conpty.dll', status: 'Valid', signerSubject: MICROSOFT },
        { path: 'conpty.node', status: 'NotSigned', signerSubject: null },
        { path: 'tampered.dll', status: 'HashMismatch', signerSubject: SIGNPATH },
        { path: 'other.dll', status: 'Valid', signerSubject: 'CN=Someone Else' }
      ],
      { expectedSigners: [SIGNPATH] }
    )
    expect(offenders.map((offender) => offender.path)).toEqual([
      'conpty.node',
      'tampered.dll',
      'other.dll'
    ])
  })

  it('compares subjects after whitespace normalization', () => {
    const spaced = 'CN = SignPath Foundation,O=SignPath Foundation, L=Lewes, S=Delaware, C=US'
    expect(
      findSignatureOffenders([{ path: 'a.exe', status: 'Valid', signerSubject: spaced }], {
        expectedSigners: [SIGNPATH]
      })
    ).toEqual([])
  })
})

describe('verifyWindowsPayloadSignatures', () => {
  it('checks every binary in one PowerShell call and reports the unsigned ones', () => {
    const root = makePayload([
      'Orca.exe',
      'resources/node_modules/node-pty/build/Release/conpty.node',
      'resources/node_modules/node-pty/build/Release/conpty/conpty.dll'
    ])
    const signers = {
      'Orca.exe': SIGNPATH,
      'resources/node_modules/node-pty/build/Release/conpty/conpty.dll': MICROSOFT
    }
    const spawn = fakePowerShell((path) => signers[path] ?? null)
    const { signatures, offenders } = verifyWindowsPayloadSignatures({
      root,
      platform: 'win32',
      spawnSyncImpl: spawn,
      expectedSigners: [SIGNPATH]
    })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][1]).not.toContain('Bypass')
    expect(signatures).toHaveLength(3)
    expect(offenders.map((offender) => offender.path)).toEqual([
      'resources/node_modules/node-pty/build/Release/conpty.node'
    ])
  })

  it('refuses to run off Windows and on an empty payload', () => {
    const root = makePayload(['resources/app.asar'])
    expect(() => verifyWindowsPayloadSignatures({ root, platform: 'linux' })).toThrow(
      'requires Windows'
    )
    expect(() =>
      verifyWindowsPayloadSignatures({ root, platform: 'win32', spawnSyncImpl: vi.fn() })
    ).toThrow('No Windows binaries')
  })

  it('fails when PowerShell returns a different number of rows', () => {
    const root = makePayload(['Orca.exe', 'a.dll'])
    const spawn = vi.fn(() => ({ status: 0, stdout: '[]', stderr: '' }))
    expect(() =>
      verifyWindowsPayloadSignatures({ root, platform: 'win32', spawnSyncImpl: spawn })
    ).toThrow('0 signatures for 2 files')
  })
})

describe('main', () => {
  const run = (argv, signerFor) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const code = main(argv, {
        platform: 'win32',
        spawnSyncImpl: fakePowerShell(signerFor),
        expectedSigners: [SIGNPATH]
      })
      return { code, output: log.mock.calls.flat().join('\n'), errors: error.mock.calls.flat() }
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  }

  it('fails a required check and lists the offenders', () => {
    const root = makePayload(['Orca.exe', 'resources/bin/orca.exe'])
    const result = run([root], (path) => (path === 'Orca.exe' ? SIGNPATH : null))
    expect(result.code).toBe(1)
    expect(result.output).toContain('1 of 2 Windows binaries lack an expected signature')
    expect(result.output).toContain('resources/bin/orca.exe')
  })

  it('passes a required check when everything is signed', () => {
    const root = makePayload(['Orca.exe'])
    expect(run([root], () => SIGNPATH).code).toBe(0)
  })

  it('only reports in advisory mode, even when the check cannot run', () => {
    const root = makePayload(['Orca.exe'])
    const unsigned = run([root, '--mode', 'advisory'], () => null)
    expect(unsigned.code).toBe(0)
    expect(unsigned.output).toContain('::notice::1 unsigned Windows binaries')
    expect(run([join(root, 'missing'), '--mode=advisory'], () => null).code).toBe(0)
  })

  it('exits 2 when a required check cannot run', () => {
    const result = run([join(tmpdir(), 'orca-payload-does-not-exist')], () => SIGNPATH)
    expect(result.code).toBe(2)
  })
})

describe('parseArgs', () => {
  it('rejects unknown modes and extra positionals', () => {
    expect(parseArgs(['dir'])).toEqual({ root: 'dir', mode: 'required' })
    expect(() => parseArgs(['dir', '--mode', 'off'])).toThrow('Usage')
    expect(() => parseArgs(['a', 'b'])).toThrow('Usage')
  })
})

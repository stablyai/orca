import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  parseGlibcVersion,
  compareGlibcVersions,
  parseVersionNeeds,
  parseNeededLibraries,
  parseImportedSymbols,
  isVersionNodeAboveFloor,
  findFloorViolations,
  findMissingProviderDeps,
  collectNativeBinaries,
  verifyLinuxGlibcFloor
} = require('./verify-linux-glibc-floor.cjs')

// 0x7f 'E' 'L' 'F' + class/data/version padding — enough for the magic check.
const ELF_HEADER = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])

// Real `objdump -p` "Version References" shape (entry: 0xHASH 0xFLAGS <n> NAME;
// flags 0x02 = VER_FLG_WEAK). Includes a symbol-less ABI marker, a weak need,
// and a libstdc++ need.
const OBJDUMP_P = [
  'Dynamic Section:',
  '  NEEDED               libc.so.6',
  '',
  'Version References:',
  '  required from libc.so.6:',
  '    0x09691a75 0x00 06 GLIBC_2.2.5',
  '    0x069691b4 0x00 05 GLIBC_2.34',
  '    0x0d696914 0x02 04 GLIBC_2.18',
  '    0x00fd0e42 0x00 03 GLIBC_ABI_DT_RELR',
  '  required from libstdc++.so.6:',
  '    0x0b481abc 0x00 07 GLIBCXX_3.4.29',
  ''
].join('\n')

describe('verify-linux-glibc-floor parsing', () => {
  it('parses and compares numeric version tuples', () => {
    expect(parseGlibcVersion('2.34')).toEqual([2, 34])
    expect(parseGlibcVersion('3.4.28')).toEqual([3, 4, 28])
    expect(compareGlibcVersions([2, 2, 5], [2, 14])).toBe(-1)
    expect(compareGlibcVersions([2, 31], [2, 32])).toBe(-1)
    expect(compareGlibcVersions([2, 34], [2, 31])).toBe(1)
    expect(compareGlibcVersions([2, 31], [2, 31])).toBe(0)
    expect(compareGlibcVersions([2, 31], [2, 31, 0])).toBe(0)
    expect(compareGlibcVersions([3, 4, 29], [3, 4, 28])).toBe(1)
  })

  it('parses objdump -p Version References into per-library version needs', () => {
    const needs = parseVersionNeeds(OBJDUMP_P)
    expect(needs).toContainEqual({ library: 'libc.so.6', name: 'GLIBC_2.34', weak: false })
    expect(needs).toContainEqual({ library: 'libc.so.6', name: 'GLIBC_ABI_DT_RELR', weak: false })
    expect(needs).toContainEqual({ library: 'libc.so.6', name: 'GLIBC_2.18', weak: true })
    expect(needs).toContainEqual({ library: 'libstdc++.so.6', name: 'GLIBCXX_3.4.29', weak: false })
  })

  it('classifies version nodes across glibc and libstdc++ families', () => {
    expect(isVersionNodeAboveFloor('GLIBC_2.34')).toBe(true)
    expect(isVersionNodeAboveFloor('GLIBC_2.31')).toBe(false)
    expect(isVersionNodeAboveFloor('GLIBC_ABI_DT_RELR')).toBe(true) // symbol-less marker (2.36+)
    // GLIBC_PRIVATE is not a stable ABI contract; a needed private symbol can be
    // absent on the floor even though the version node exists — reject it.
    expect(isVersionNodeAboveFloor('GLIBC_PRIVATE')).toBe(true)
    expect(isVersionNodeAboveFloor('CXXABI_TM_1')).toBe(false) // named libstdc++ node on 20.04
    expect(isVersionNodeAboveFloor('GLIBCXX_3.4.29')).toBe(true) // GCC 11, above 20.04's 3.4.28
    expect(isVersionNodeAboveFloor('GLIBCXX_3.4.28')).toBe(false)
    expect(isVersionNodeAboveFloor('CXXABI_1.3.13')).toBe(true)
    expect(isVersionNodeAboveFloor('CXXABI_1.3.12')).toBe(false)
    expect(isVersionNodeAboveFloor('GCC_3.0')).toBe(false) // family not gated
  })

  it('flags strong too-new glibc + libstdc++ needs, skipping weak and ungated families', () => {
    const violations = findFloorViolations(parseVersionNeeds(OBJDUMP_P), '/opt/app/pty.node')
    const names = violations.map((v) => v.name).sort()
    // GLIBC_2.34, GLIBC_ABI_DT_RELR, GLIBCXX_3.4.29 fail; weak GLIBC_2.18 and
    // GLIBC_2.2.5 are excluded.
    expect(names).toEqual(['GLIBCXX_3.4.29', 'GLIBC_2.34', 'GLIBC_ABI_DT_RELR'].sort())
  })

  it('exempts sherpa-onnx from the libstdc++ floor but still gates its glibc', () => {
    const needs = [
      { library: 'libstdc++.so.6', name: 'GLIBCXX_3.4.29', weak: false },
      { library: 'libc.so.6', name: 'GLIBC_2.34', weak: false }
    ]
    // A launch-critical module: both are violations.
    expect(
      findFloorViolations(needs, '/opt/app/node_modules/node-pty/pty.node').map((v) => v.name)
    ).toEqual(['GLIBCXX_3.4.29', 'GLIBC_2.34'])
    // sherpa: GLIBCXX exempt (lazy speech prebuilt), glibc still enforced.
    expect(
      findFloorViolations(
        needs,
        '/opt/app/node_modules/sherpa-onnx-linux-x64/sherpa-onnx.node'
      ).map((v) => v.name)
    ).toEqual(['GLIBC_2.34'])
  })

  it('reports no violations when every strong need is at or below the floor', () => {
    const needs = parseVersionNeeds(
      [
        'Version References:',
        '  required from libc.so.6:',
        '    0x00 0x00 02 GLIBC_2.2.5',
        '    0x00 0x00 03 GLIBC_2.28',
        '  required from libstdc++.so.6:',
        '    0x00 0x00 04 GLIBCXX_3.4.22'
      ].join('\n')
    )
    expect(findFloorViolations(needs, '/opt/app/pty.node')).toEqual([])
  })
})

describe('DT_NEEDED provider check', () => {
  const OBJDUMP_P_DYNAMIC = [
    'Dynamic Section:',
    '  NEEDED               libutil.so.1',
    '  NEEDED               libpthread.so.0',
    '  NEEDED               libc.so.6',
    '',
    'Version References:',
    '  required from libc.so.6:',
    '    0x0 0x00 02 GLIBC_2.2.5'
  ].join('\n')

  it('parses DT_NEEDED shared libraries from objdump -p', () => {
    const needed = parseNeededLibraries(OBJDUMP_P_DYNAMIC)
    expect([...needed].sort()).toEqual(['libc.so.6', 'libpthread.so.0', 'libutil.so.1'])
  })

  it('parses undefined imported symbols from objdump -T, stripping @VERSION', () => {
    const output = [
      '0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.2.5) openpty',
      '0000000000000000  w   DF *UND*\t0000000000000000 __cxa_finalize@GLIBC_2.2.5',
      '0000000000000000      DF .text\t0000000000000000 defined_symbol'
    ].join('\n')
    const imported = parseImportedSymbols(output)
    expect(imported.has('openpty')).toBe(true)
    expect(imported.has('__cxa_finalize')).toBe(true)
    expect(imported.has('defined_symbol')).toBe(false) // not *UND*
  })

  it('flags a binary that imports openpty/forkpty without libutil.so.1 in DT_NEEDED', () => {
    const importsPty = new Set(['openpty', 'forkpty', 'free'])
    // Missing libutil.so.1 -> the pinned symbols would not resolve on the floor.
    expect(
      findMissingProviderDeps(importsPty, new Set(['libc.so.6'])).map((m) => m.symbol)
    ).toEqual(['openpty', 'forkpty'])
    // With libutil.so.1 present, no violation.
    expect(findMissingProviderDeps(importsPty, new Set(['libc.so.6', 'libutil.so.1']))).toEqual([])
    // A binary that doesn't import the relocated symbols is never flagged.
    expect(findMissingProviderDeps(new Set(['free']), new Set(['libc.so.6']))).toEqual([])
  })
})

describe('collectNativeBinaries', () => {
  it('collects only ELF .node/.so/executable files, skipping non-ELF and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-glibc-collect-'))
    try {
      await mkdir(join(root, 'nested'), { recursive: true })
      await writeFile(join(root, 'addon.node'), ELF_HEADER)
      await writeFile(join(root, 'nested', 'lib.so'), ELF_HEADER)
      await writeFile(join(root, 'nested', 'lib.so.1'), ELF_HEADER)
      await writeFile(join(root, 'orca-ide'), ELF_HEADER) // extensionless executable
      await writeFile(join(root, 'script.js'), ELF_HEADER) // has extension, not native
      await writeFile(join(root, 'text.node'), 'not an elf file') // native name, non-ELF
      await writeFile(join(root, 'notes.md'), ELF_HEADER)
      try {
        await symlink(join(root, 'addon.node'), join(root, 'alias.node'))
      } catch {
        // Symlink creation can be restricted; the rest of the assertions still hold.
      }

      const found = collectNativeBinaries(root).map((p) => p.slice(root.length + 1))
      expect(found).toContain('addon.node')
      expect(found).toContain(join('nested', 'lib.so'))
      expect(found).toContain(join('nested', 'lib.so.1'))
      expect(found).toContain('orca-ide')
      expect(found).not.toContain('script.js')
      expect(found).not.toContain('text.node')
      expect(found).not.toContain('notes.md')
      expect(found).not.toContain('alias.node')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform === 'win32')('verifyLinuxGlibcFloor', () => {
  // A stub objdump keyed on the inspected file's basename. Handles `-p` (Dynamic
  // Section DT_NEEDED + Version References) and `-T` (undefined symbols).
  // `*fail*` exits non-zero (fail-closed branch); `*noutil*` omits libutil.so.1
  // from DT_NEEDED; `*pty*` imports openpty. Match on basename only so the
  // (random) temp-dir path cannot collide.
  async function writeStubObjdump(dir) {
    const stubPath = join(dir, 'objdump-stub.sh')
    await writeFile(
      stubPath,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "GNU objdump (stub)"; exit 0; fi',
        'f=$(basename "$2")',
        'case "$f" in',
        '  *fail*) echo "objdump: $f: File format not recognized" >&2; exit 1 ;;',
        'esac',
        'if [ "$1" = "-T" ]; then',
        '  case "$f" in',
        '    *pty*) printf "0000 DF *UND* 0000 (GLIBC_2.2.5) openpty\\n" ;;',
        '  esac',
        '  exit 0',
        'fi',
        'printf "Dynamic Section:\\n  NEEDED               libc.so.6\\n"',
        'case "$f" in',
        '  *noutil*) : ;;',
        '  *) printf "  NEEDED               libutil.so.1\\n  NEEDED               libpthread.so.0\\n" ;;',
        'esac',
        'printf "\\nVersion References:\\n  required from libc.so.6:\\n"',
        'case "$f" in',
        '  *bad*)      printf "    0x0 0x00 03 GLIBC_2.34\\n    0x0 0x00 04 GLIBC_2.2.5\\n" ;;',
        '  *relr*)     printf "    0x0 0x00 05 GLIBC_ABI_DT_RELR\\n    0x0 0x00 04 GLIBC_2.2.5\\n" ;;',
        '  *weakonly*) printf "    0x0 0x02 06 GLIBC_2.32\\n    0x0 0x00 04 GLIBC_2.2.5\\n" ;;',
        '  *cxx*|*sherpa*)',
        '    printf "  required from libstdc++.so.6:\\n    0x0 0x00 07 GLIBCXX_3.4.29\\n" ;;',
        '  *)          printf "    0x0 0x00 08 GLIBC_2.28\\n    0x0 0x00 04 GLIBC_2.2.5\\n" ;;',
        'esac',
        'exit 0'
      ].join('\n'),
      { mode: 0o755 }
    )
    return stubPath
  }

  it('throws listing binaries over the floor (glibc, DT_RELR marker, and libstdc++)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-glibc-over-'))
    try {
      const objdumpPath = await writeStubObjdump(root)
      await mkdir(join(root, 'app', 'resources'), { recursive: true })
      await writeFile(join(root, 'app', 'resources', 'bad-pty.node'), ELF_HEADER)
      await writeFile(join(root, 'app', 'relr-exe.node'), ELF_HEADER)
      await writeFile(join(root, 'app', 'cxx-addon.node'), ELF_HEADER) // launch-critical GLIBCXX_3.4.29
      await writeFile(join(root, 'app', 'good.so'), ELF_HEADER)

      let error
      try {
        verifyLinuxGlibcFloor(join(root, 'app'), { objdumpPath })
      } catch (e) {
        error = e
      }
      expect(error).toBeDefined()
      expect(error.message).toMatch(/bad-pty\.node needs GLIBC_2\.34/)
      expect(error.message).toMatch(/relr-exe\.node needs GLIBC_ABI_DT_RELR/)
      expect(error.message).toMatch(/cxx-addon\.node needs GLIBCXX_3\.4\.29/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('throws when a pinned binary imports openpty without libutil.so.1 in DT_NEEDED', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-glibc-noutil-'))
    try {
      const objdumpPath = await writeStubObjdump(root)
      await mkdir(join(root, 'app'), { recursive: true })
      // Below the version floor (so the version check passes) but libutil.so.1
      // is missing from DT_NEEDED — openpty would not resolve on Ubuntu 20.04.
      await writeFile(join(root, 'app', 'noutil-pty.node'), ELF_HEADER)

      expect(() => verifyLinuxGlibcFloor(join(root, 'app'), { objdumpPath })).toThrow(
        /noutil-pty\.node imports openpty but libutil\.so\.1 is not in DT_NEEDED/
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('passes weak/at-floor needs and the exempt sherpa-onnx libstdc++ prebuilt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-glibc-under-'))
    try {
      const objdumpPath = await writeStubObjdump(root)
      const sherpaDir = join(root, 'app', 'node_modules', 'sherpa-onnx-linux-x64')
      await mkdir(sherpaDir, { recursive: true })
      await writeFile(join(root, 'app', 'good-pty.node'), ELF_HEADER)
      await writeFile(join(root, 'app', 'weakonly-lib.so'), ELF_HEADER) // weak GLIBC_2.32 → OK
      await writeFile(join(root, 'app', 'orca-ide'), ELF_HEADER)
      await writeFile(join(sherpaDir, 'sherpa-onnx.node'), ELF_HEADER) // GLIBCXX_3.4.29, exempt

      expect(() => verifyLinuxGlibcFloor(join(root, 'app'), { objdumpPath })).not.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when objdump cannot read a binary (non-zero exit)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-glibc-closed-'))
    try {
      const objdumpPath = await writeStubObjdump(root)
      await mkdir(join(root, 'app'), { recursive: true })
      await writeFile(join(root, 'app', 'unreadable-fail.node'), ELF_HEADER)

      expect(() => verifyLinuxGlibcFloor(join(root, 'app'), { objdumpPath })).toThrow(
        /objdump -p failed/
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is a no-op (no objdump needed) when there are no native binaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-glibc-empty-'))
    try {
      await mkdir(join(root, 'app'), { recursive: true })
      await writeFile(join(root, 'app', 'readme.txt'), 'no binaries here')
      expect(() =>
        verifyLinuxGlibcFloor(join(root, 'app'), { objdumpPath: '/nonexistent/objdump' })
      ).not.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

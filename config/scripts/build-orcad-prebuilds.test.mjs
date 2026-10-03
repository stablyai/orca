import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertNodePtyPatchApplied,
  bindingGypForLibc,
  ptySourceForLibc,
  detectLibc,
  MATRIX_SLOTS,
  readManifest,
  requestedSlots,
  slotName
} from './build-orcad-prebuilds.mjs'

const PATCHED_BINDING_GYP =
  "'ldflags': ['-Wl,--no-as-needed,-l:libutil.so.1,-l:libpthread.so.0,--as-needed']"
const PATCHED_PTY_CC = [
  '__asm__(".symver openpty,openpty@" ORCA_GLIBC_COMPAT_VERSION);',
  '__asm__(".symver cfsetispeed,cfsetispeed@" ORCA_GLIBC_COMPAT_VERSION);',
  '__asm__(".symver cfsetospeed,cfsetospeed@" ORCA_GLIBC_COMPAT_VERSION);'
].join('\n')
// The pre-2.42 shape of the patch: relocation pins present, baud-rate pins absent.
const PTY_CC_WITHOUT_BAUD_PINS = '__asm__(".symver openpty,openpty@" ORCA_GLIBC_COMPAT_VERSION);'

const dirs = []
const stage = (bindingGyp, ptyCc) => {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-prebuild-src-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'src', 'unix'), { recursive: true })
  writeFileSync(join(dir, 'binding.gyp'), bindingGyp)
  writeFileSync(join(dir, 'src', 'unix', 'pty.cc'), ptyCc)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('assertNodePtyPatchApplied', () => {
  it('accepts a tree with both halves of the glibc-floor fix', () => {
    expect(() =>
      assertNodePtyPatchApplied(stage(PATCHED_BINDING_GYP, PATCHED_PTY_CC))
    ).not.toThrow()
  })

  it('refuses to build when the ldflags half is missing', () => {
    // The .symver pins alone let gcc's --as-needed drop libutil/libpthread from
    // DT_NEEDED, which loads on the build host and fails on Ubuntu 20.04 — #9902 again,
    // this time baked into a shipped prebuilt.
    expect(() => assertNodePtyPatchApplied(stage("'ldflags': []", PATCHED_PTY_CC))).toThrow(
      /--no-as-needed,-l:libutil\.so\.1/
    )
  })

  it('refuses to build when the .symver pins are missing', () => {
    expect(() => assertNodePtyPatchApplied(stage(PATCHED_BINDING_GYP, '// upstream'))).toThrow(
      /\.symver glibc pins/
    )
  })

  it('refuses to build when only the glibc 2.42 baud-rate pins are missing', () => {
    expect(() =>
      assertNodePtyPatchApplied(stage(PATCHED_BINDING_GYP, PTY_CC_WITHOUT_BAUD_PINS))
    ).toThrow(/cfsetispeed pin \(glibc 2\.42\)[\s\S]*cfsetospeed pin \(glibc 2\.42\)/)
  })

  it('names the patch and the doc so the fix is findable', () => {
    expect(() => assertNodePtyPatchApplied(stage("'ldflags': []", '// upstream'))).toThrow(
      /config\/patches\/node-pty@1\.1\.0\.patch/
    )
  })
})

describe('slot naming', () => {
  it('covers every platform orcad ships to', () => {
    expect([...MATRIX_SLOTS].sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64-glibc',
      'linux-arm64-musl',
      'linux-x64-glibc',
      'linux-x64-musl',
      'win32-arm64',
      'win32-x64'
    ])
  })

  it('requires the whole matrix by default and only the named slots otherwise', () => {
    expect(requestedSlots(['node', 'x'])).toBeNull()
    expect(requestedSlots(['node', 'x', '--require-slots'])).toEqual(MATRIX_SLOTS)
    expect(requestedSlots(['node', 'x', '--require-slots', 'darwin-arm64'])).toEqual([
      'darwin-arm64'
    ])
    expect(requestedSlots(['node', 'x', '--require-slots=win32-x64,win32-arm64'])).toEqual([
      'win32-x64',
      'win32-arm64'
    ])
  })

  it('lets CI force the label so the container decides glibc vs musl', () => {
    // Detection inside a container that happens to run a differently-linked Node would
    // file the build under the wrong slot. The forced label must beat detection outright,
    // so assert against one detection could never produce for this platform/arch.
    expect(slotName(['node', 'x', '--slot=linux-x64-glibc'], 'linux', 'arm64')).toBe(
      'linux-x64-glibc'
    )
  })

  it('omits the libc dimension off Linux', () => {
    expect(slotName([], 'darwin', 'arm64')).toBe('darwin-arm64')
  })

  it('reads glibc from the report header and musl from its absence', () => {
    expect(detectLibc('linux', { glibcVersionRuntime: '2.31' })).toBe('glibc')
    expect(detectLibc('linux', {})).toBe('musl')
    expect(detectLibc('darwin', { glibcVersionRuntime: '2.31' })).toBe('none')
  })
})

describe('bindingGypForLibc', () => {
  const gyp =
    "'ldflags': [\n  '-Wl,--no-as-needed,-l:libutil.so.1,-l:libpthread.so.0,--as-needed'\n]"

  it('keeps the glibc DT_NEEDED ldflag everywhere but musl', () => {
    expect(bindingGypForLibc(gyp, 'glibc')).toBe(gyp)
    expect(bindingGypForLibc(gyp, 'none')).toBe(gyp)
  })

  it('drops it on musl, which has no libutil.so.1 to link', () => {
    expect(bindingGypForLibc(gyp, 'musl')).not.toContain('libutil.so.1')
  })

  it('matches the binding.gyp the installed patch produces', () => {
    const require = createRequire(import.meta.url)
    const installed = readFileSync(
      join(dirname(require.resolve('node-pty/package.json')), 'binding.gyp'),
      'utf8'
    )
    expect(bindingGypForLibc(installed, 'musl')).not.toContain('-l:libutil.so.1')
  })

  it('fails loudly if the patch stops carrying the flag it strips', () => {
    expect(() => bindingGypForLibc("'ldflags': []", 'musl')).toThrow(/no longer carries/)
  })
})

describe('ptySourceForLibc', () => {
  const source =
    '#if defined(__linux__)\n#  if defined(__x86_64__)\n#    define ORCA_GLIBC_COMPAT_VERSION "GLIBC_2.2.5"\n'

  it('keeps the glibc .symver pins everywhere but musl', () => {
    expect(ptySourceForLibc(source, 'glibc')).toBe(source)
    expect(ptySourceForLibc(source, 'none')).toBe(source)
  })

  it('scopes them to glibc on musl, whose libc has no GLIBC_ versions to bind', () => {
    expect(ptySourceForLibc(source, 'musl')).toMatch(
      /^#if defined\(__linux__\) && defined\(__GLIBC__\)\n/
    )
  })

  it('matches the pty.cc the installed patch produces', () => {
    const require = createRequire(import.meta.url)
    const installed = readFileSync(
      join(dirname(require.resolve('node-pty/package.json')), 'src', 'unix', 'pty.cc'),
      'utf8'
    )
    expect(ptySourceForLibc(installed, 'musl')).toContain('defined(__GLIBC__)')
  })

  it('fails loudly if the patch stops carrying the guard it scopes', () => {
    expect(() => ptySourceForLibc('int main() {}', 'musl')).toThrow(/no longer carries/)
  })
})

describe('readManifest', () => {
  it('returns null instead of throwing when no matrix has been built', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-prebuild-manifest-'))
    dirs.push(dir)
    expect(readManifest(dir)).toBeNull()
  })
})

// Run the actual entry point so the libc decision also guards manifest publication.
describe('prebuild floor gate', () => {
  const runBuild = (header, { slot, reject = false } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-prebuild-gate-'))
    dirs.push(root)
    const scripts = join(root, 'config', 'scripts')
    const moduleDir = join(root, 'node_modules', 'node-pty')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(join(moduleDir, 'build', 'Release'), { recursive: true })
    mkdirSync(join(moduleDir, 'src', 'unix'), { recursive: true })
    mkdirSync(join(moduleDir, 'scripts'), { recursive: true })
    writeFileSync(join(moduleDir, 'scripts', 'orca-glibc.py'), '# compiler probe fixture')
    mkdirSync(join(root, 'src', 'shared'), { recursive: true })
    copyFileSync(
      new URL('../../src/shared/node-runtime-pin.ts', import.meta.url),
      join(root, 'src', 'shared', 'node-runtime-pin.ts')
    )
    copyFileSync(
      new URL('./orcad-prebuild-slot-contents.mjs', import.meta.url),
      join(scripts, 'orcad-prebuild-slot-contents.mjs')
    )
    const apiDir = join(root, 'node_modules', 'node-addon-api')
    mkdirSync(apiDir, { recursive: true })
    writeFileSync(join(apiDir, 'package.json'), JSON.stringify({ name: 'node-addon-api' }))
    writeFileSync(
      join(scripts, 'pinned-node-downloads.mjs'),
      `export async function preparePinnedNodeDir({ workDir }) { return workDir }
       export async function ensurePinnedNodeExecutable() {
         throw new Error('unexpected runtime download in build-only fixture');
       }`
    )
    writeFileSync(
      join(scripts, 'script-child-process.mjs'),
      `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
       import { join } from 'node:path';
       export function runProcessSync({ cwd }) {
         if (!existsSync(join(cwd, 'scripts', 'orca-glibc.py'))) {
           throw new Error('compiler probe missing from staged sources');
         }
         mkdirSync(join(cwd, 'build', 'Release'), { recursive: true });
         writeFileSync(join(cwd, 'build', 'Release', 'pty.node'), 'fixture');
         return { code: 0 };
       }`
    )
    copyFileSync(
      new URL('./build-orcad-prebuilds.mjs', import.meta.url),
      join(scripts, 'build-orcad-prebuilds.mjs')
    )
    writeFileSync(join(moduleDir, 'package.json'), JSON.stringify({ version: '1.1.0' }))
    writeFileSync(join(moduleDir, 'binding.gyp'), PATCHED_BINDING_GYP)
    writeFileSync(
      join(moduleDir, 'src', 'unix', 'pty.cc'),
      `#if defined(__linux__) && defined(__GLIBC__)
#  if defined(__x86_64__)
#    define ORCA_GLIBC_COMPAT_VERSION "GLIBC_2.2.5"
${PATCHED_PTY_CC}`
    )
    writeFileSync(join(moduleDir, 'build', 'Release', 'pty.node'), 'fixture')
    writeFileSync(
      join(scripts, 'verify-linux-glibc-floor.cjs'),
      `exports.verifyLinuxGlibcFloor = () => {
        console.log('floor gate called');
        if (${reject}) throw new Error('floor rejected fixture');
      };
      exports.collectNativeBinaries = (dir) => [require('node:path').join(dir, 'pty.node')];
      exports.findArchViolation = () => null;
      exports.readDynamicInfo = () => ({ versionNeeds: [] });`
    )
    const preload = join(root, 'platform.cjs')
    writeFileSync(
      preload,
      `Object.defineProperty(process, 'platform', { value: 'linux' });
       process.report.getReport = () => ({ header: ${JSON.stringify(header)} });`
    )
    const result = spawnSync(
      process.execPath,
      [
        '--require',
        preload,
        join(scripts, 'build-orcad-prebuilds.mjs'),
        ...(slot ? [`--slot=${slot}`] : [])
      ],
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    )
    return { ...result, manifest: join(root, 'out', 'orcad-prebuilds', 'manifest.json') }
  }

  it('publishes a musl slot without applying glibc requirements', () => {
    const result = runBuild({}, { reject: true })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('floor gate called')
    expect(existsSync(result.manifest)).toBe(true)
    expect(readManifest(dirname(result.manifest))).toMatchObject({
      schemaVersion: 2,
      napi: 8,
      slots: { [`linux-${process.arch}-musl`]: { libc: 'musl', glibc: null } }
    })
  })

  it('gates glibc artifacts before publishing the manifest', () => {
    const result = runBuild({ glibcVersionRuntime: '2.43' }, { reject: true })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('floor rejected fixture')
    expect(existsSync(result.manifest)).toBe(false)
  })

  it('does not let a forced musl label bypass the gate on glibc', () => {
    const result = runBuild(
      { glibcVersionRuntime: '2.43' },
      { slot: 'linux-x64-musl', reject: true }
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('floor rejected fixture')
    expect(existsSync(result.manifest)).toBe(false)
  })

  it('publishes a glibc slot after its floor gate passes', () => {
    const result = runBuild({ glibcVersionRuntime: '2.43' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('floor gate called')
    expect(existsSync(result.manifest)).toBe(true)
  })

  it('refuses to publish when the Linux libc report is unavailable', () => {
    const result = runBuild(undefined, { slot: 'linux-x64-musl' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('cannot determine the build host libc')
    expect(existsSync(result.manifest)).toBe(false)
  })
})

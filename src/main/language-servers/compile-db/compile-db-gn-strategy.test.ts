import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../../../shared/child-process/process-spec'
import {
  buildGnGenArgs,
  buildNinjaCompdbArgs,
  detectConfiguredGnOutDir,
  gnHelpOffersAddExportCompileCommands,
  probeGnAddExportCompileCommands,
  runGnCompileDbGeneration
} from './compile-db-gn-strategy'
import {
  GN_ADD_EXPORT_COMPILE_COMMANDS_FLAG,
  GN_BUILD_NINJA_FILENAME,
  GN_EXPORT_ALL_TARGETS_PATTERN,
  NINJA_COMPDB_EXPAND_RSP_FLAG,
  NINJA_COMPDB_RULES
} from './compile-db-strategy-types'
import type { GnRunner } from './compile-db-strategy-types'

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gn-strategy-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true })
  }
})

function result(partial: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...partial }
}

function withBuildNinja(root: string, rel: string): string {
  const dir = join(root, rel)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, GN_BUILD_NINJA_FILENAME), 'rule cc\n')
  return dir
}

function runner(
  impl: (spec: { program: string; args: readonly string[] }) => ProcessResult
): GnRunner {
  return vi.fn(async (spec: { program: string; args: readonly string[] }) =>
    impl(spec)
  ) as unknown as GnRunner
}

// A realistic new-GN `gn help gen` excerpt advertising the add-export switch.
const NEW_GN_HELP = `gn gen: Generates ninja files for the given out directory.
  --add-export-compile-commands=<label_pattern>
      Writes a compile_commands.json listing the compile commands for the
      given label pattern (e.g. //base:base).`
// An old-GN (pre-2022-09) help excerpt: only the deprecated export switch.
const OLD_GN_HELP = `gn gen: Generates ninja files for the given out directory.
  --export-compile-commands[=bool]
      Writes compile_commands.json for the default toolchain.`

describe('gnHelpOffersAddExportCompileCommands (2022-09 断代)', () => {
  it('returns true for new-GN help advertising --add-export-compile-commands', () => {
    expect(gnHelpOffersAddExportCompileCommands(NEW_GN_HELP)).toBe(true)
  })

  it('returns false for old-GN help that only lists the deprecated --export-compile-commands', () => {
    expect(gnHelpOffersAddExportCompileCommands(OLD_GN_HELP)).toBe(false)
  })

  it('returns false for an empty/blank probe output', () => {
    expect(gnHelpOffersAddExportCompileCommands('')).toBe(false)
  })

  it('matches the flag as a substring regardless of trailing description', () => {
    expect(gnHelpOffersAddExportCompileCommands('  --add-export-compile-commands=//*  all')).toBe(
      true
    )
  })

  it('does not match the deprecated --export-compile-commands (no add- prefix)', () => {
    expect(gnHelpOffersAddExportCompileCommands('  --export-compile-commands')).toBe(false)
  })
})

describe('buildGnGenArgs', () => {
  it('emits gen <out> --add-export-compile-commands=//*', () => {
    expect(buildGnGenArgs('out/Default')).toEqual([
      'gen',
      'out/Default',
      `${GN_ADD_EXPORT_COMPILE_COMMANDS_FLAG}=${GN_EXPORT_ALL_TARGETS_PATTERN}`
    ])
  })

  it('passes an absolute out dir through', () => {
    const abs = join('C:', 'proj', 'out', 'Release')
    expect(buildGnGenArgs(abs)).toContain(abs)
    expect(buildGnGenArgs(abs)[0]).toBe('gen')
  })
})

describe('buildNinjaCompdbArgs', () => {
  it('emits -C <out> -t compdb -x cc cxx objc objcxx', () => {
    expect(buildNinjaCompdbArgs('out/Default')).toEqual([
      '-C',
      'out/Default',
      '-t',
      'compdb',
      NINJA_COMPDB_EXPAND_RSP_FLAG,
      ...NINJA_COMPDB_RULES
    ])
  })

  it('always includes -x (required on Windows, harmless elsewhere)', () => {
    // Windows acceptance box: the fallback MUST carry -x for @rsp expansion.
    expect(buildNinjaCompdbArgs('out/Default')).toContain(NINJA_COMPDB_EXPAND_RSP_FLAG)
  })

  it('includes all four language rules', () => {
    const args = buildNinjaCompdbArgs('out/Default')
    for (const rule of NINJA_COMPDB_RULES) {
      expect(args).toContain(rule)
    }
  })
})

describe('detectConfiguredGnOutDir', () => {
  it('returns null when no build.ninja exists anywhere', () => {
    const root = makeTempRoot()
    expect(detectConfiguredGnOutDir(root)).toBeNull()
  })

  it('detects a curated out/Default dir with build.ninja', () => {
    const root = makeTempRoot()
    const dir = withBuildNinja(root, 'out/Default')
    expect(detectConfiguredGnOutDir(root)).toBe(dir)
  })

  it('detects out/Debug and out/Release candidates', () => {
    const root = makeTempRoot()
    const dir = withBuildNinja(root, 'out/Release')
    expect(detectConfiguredGnOutDir(root)).toBe(dir)
  })

  it('detects a bare out/ dir with build.ninja', () => {
    const root = makeTempRoot()
    const dir = withBuildNinja(root, 'out')
    expect(detectConfiguredGnOutDir(root)).toBe(dir)
  })

  it('detects a custom out/<name> dir via the out/ subdir scan', () => {
    const root = makeTempRoot()
    const dir = withBuildNinja(root, 'out/my-team-config')
    expect(detectConfiguredGnOutDir(root)).toBe(dir)
  })

  it('detects a root-level build.ninja', () => {
    const root = makeTempRoot()
    writeFileSync(join(root, GN_BUILD_NINJA_FILENAME), 'rule cc\n')
    expect(detectConfiguredGnOutDir(root)).toBe(root)
  })

  it('ignores out dirs without build.ninja', () => {
    const root = makeTempRoot()
    mkdirSync(join(root, 'out'), { recursive: true })
    mkdirSync(join(root, 'out', 'Default'), { recursive: true })
    expect(detectConfiguredGnOutDir(root)).toBeNull()
  })

  it('prefers the curated out/Default over a custom sibling (deterministic order)', () => {
    const root = makeTempRoot()
    const curated = withBuildNinja(root, 'out/Default')
    withBuildNinja(root, 'out/zzz-custom')
    expect(detectConfiguredGnOutDir(root)).toBe(curated)
  })
})

describe('probeGnAddExportCompileCommands', () => {
  it('runs gn help gen and reports true for new-GN help output', async () => {
    const run = runner(() => result({ stdout: NEW_GN_HELP }))
    expect(await probeGnAddExportCompileCommands('gn', run)).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('reports false for old-GN help output', async () => {
    const run = runner(() => result({ stdout: OLD_GN_HELP }))
    expect(await probeGnAddExportCompileCommands('gn', run)).toBe(false)
  })

  it('reports false when gn exits non-zero', async () => {
    const run = runner(() => result({ code: 1, stderr: 'unknown command' }))
    expect(await probeGnAddExportCompileCommands('gn', run)).toBe(false)
  })

  it('reports false on a timeout (safe -> ninja fallback)', async () => {
    const run = runner(() => result({ code: null, timedOut: true }))
    expect(await probeGnAddExportCompileCommands('gn', run)).toBe(false)
  })

  it('reports false when gn cannot be started (rejects -> assume old)', async () => {
    const run = vi.fn(async () => {
      throw new Error('ENOENT gn')
    }) as unknown as GnRunner
    expect(await probeGnAddExportCompileCommands('gn', run)).toBe(false)
  })
})

describe('runGnCompileDbGeneration — new-GN path (gn gen)', () => {
  it('runs gn gen <out> --add-export-compile-commands=//* with cwd=root', async () => {
    const root = makeTempRoot()
    const run = runner(() => result())
    await runGnCompileDbGeneration(root, join(root, 'out', 'Default'), true, run)
    const spec = (run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(spec.program).toBe('gn')
    expect(spec.args).toEqual(buildGnGenArgs(join(root, 'out', 'Default')))
    expect(spec.cwd).toBe(root)
  })

  it('reports success and path=gn-gen on exit 0', async () => {
    const root = makeTempRoot()
    const out = withBuildNinja(root, 'out/Default')
    const run = runner(() => result())
    const outcome = await runGnCompileDbGeneration(root, out, true, run)
    expect(outcome.success).toBe(true)
    expect(outcome.path).toBe('gn-gen')
  })

  it('reports failure on a non-zero exit', async () => {
    const root = makeTempRoot()
    const run = runner(() => result({ code: 1, stderr: 'ERROR: bad target' }))
    const outcome = await runGnCompileDbGeneration(root, join(root, 'out'), true, run)
    expect(outcome.success).toBe(false)
    expect(outcome.stderr).toBe('ERROR: bad target')
  })

  it('reports failure on a timeout', async () => {
    const root = makeTempRoot()
    const run = runner(() => result({ code: null, timedOut: true }))
    const outcome = await runGnCompileDbGeneration(root, join(root, 'out'), true, run)
    expect(outcome.success).toBe(false)
  })
})

describe('runGnCompileDbGeneration — old-GN fallback (ninja -t compdb -x)', () => {
  it('runs ninja -C <out> -t compdb -x cc cxx objc objcxx with cwd=root', async () => {
    const root = makeTempRoot()
    const out = withBuildNinja(root, 'out/Default')
    const run = runner(() => result({ stdout: '[]' }))
    await runGnCompileDbGeneration(root, out, false, run)
    const spec = (run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(spec.program).toBe('ninja')
    expect(spec.args).toEqual(buildNinjaCompdbArgs(out))
    expect(spec.cwd).toBe(root)
  })

  it('writes ninja stdout to <out>/compile_commands.json on success', async () => {
    const root = makeTempRoot()
    const out = withBuildNinja(root, 'out/Default')
    const dbJson = JSON.stringify([
      { directory: root, file: join(root, 'a.cpp'), arguments: ['clang++', '-c', 'a.cpp'] }
    ])
    const run = runner(() => result({ stdout: dbJson }))
    const outcome = await runGnCompileDbGeneration(root, out, false, run)
    expect(outcome.success).toBe(true)
    expect(outcome.path).toBe('ninja-compdb')
    expect(existsSync(join(out, 'compile_commands.json'))).toBe(true)
    expect(readFileSync(join(out, 'compile_commands.json'), 'utf8')).toBe(dbJson)
  })

  it('does NOT write the db file on a non-zero exit', async () => {
    const root = makeTempRoot()
    const out = withBuildNinja(root, 'out/Default')
    const run = runner(() => result({ code: 1, stderr: 'ninja: error' }))
    const outcome = await runGnCompileDbGeneration(root, out, false, run)
    expect(outcome.success).toBe(false)
    expect(existsSync(join(out, 'compile_commands.json'))).toBe(false)
  })

  it('reports failure + does not write the db when ninja stdout is truncated', async () => {
    const root = makeTempRoot()
    const out = withBuildNinja(root, 'out/Default')
    const run = runner(() => result({ stdout: 'partial', outputTruncated: true }))
    const outcome = await runGnCompileDbGeneration(root, out, false, run)
    expect(outcome.success).toBe(false)
    expect(outcome.outputTruncated).toBe(true)
    expect(existsSync(join(out, 'compile_commands.json'))).toBe(false)
  })
})

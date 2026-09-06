import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from '../../src/shared/child-process/run-process.ts'
import { resolveCliCommand } from '../../src/shared/node-cli-command-resolution.ts'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

/**
 * Run the command that actually consumes the patch hashes.
 *
 * A hash comparison is not this check. `@vscode/windows-process-tree@0.8.0` shipped
 * twice with a hand-computed `sha256(patchBytes)` in the lockfile, and two separate
 * reviews "verified" it by recomputing the same number the same wrong way. pnpm
 * hashes the **LF-normalized** content, so a CRLF patch makes the raw digest a value
 * pnpm will never produce, and `--frozen-lockfile` dies with
 * ERR_PNPM_LOCKFILE_CONFIG_MISMATCH on every runner. An independent check that
 * repeats the original assumption is not independent; only the installer is.
 *
 * `--lockfile-only --ignore-scripts` keeps it to the resolution pnpm rejects on,
 * with no node_modules and no native builds.
 */
const PROJECT_DIR = resolve(import.meta.dirname, '../..')
const WINDOWS_PROCESS_TREE_PATCH = '@vscode__windows-process-tree@0.8.0.patch'

/**
 * Which pnpm to run belongs to pnpm-cli-invocation.mjs, not to this file: naming
 * the Windows shim here is what windows-cmd-shim-spawn-boundary.test.mjs rejects.
 * Its `shell` is dropped on purpose -- runProcessSync refuses that flag and
 * already drives a shim through the interpreter itself.
 */
function resolvePnpmInvocation() {
  const { command, prefixArgs } = resolvePnpmCliInvocation()
  if (isAbsolute(command)) {
    return existsSync(command) ? { program: command, prefixArgs } : null
  }
  // Bare name only when npm_execpath is unset (bare `vitest`, not `pnpm test`).
  // Drop the extension so the shared resolver tries every executable form of it.
  const resolved = resolveCliCommand(parse(command).name)
  return isAbsolute(resolved) ? { program: resolved, prefixArgs } : null
}

describe('patched dependencies', () => {
  it('installs with --frozen-lockfile, which is what validates every patch hash', () => {
    const pnpm = resolvePnpmInvocation()
    expect(pnpm, 'pnpm must be installed; it is the only thing that can check this').not.toBeNull()

    // A copy, because a --frozen-lockfile run still rewrites parts of the
    // lockfile this repo does not track, and the real one must not move.
    const scratch = mkdtempSync(join(tmpdir(), 'orca-frozen-install-'))
    try {
      for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
        copyFileSync(join(PROJECT_DIR, file), join(scratch, file))
      }
      mkdirSync(join(scratch, 'config'), { recursive: true })
      cpSync(join(PROJECT_DIR, 'config', 'patches'), join(scratch, 'config', 'patches'), {
        recursive: true
      })

      const result = runProcessSync({
        program: pnpm.program,
        args: [
          ...pnpm.prefixArgs,
          'install',
          '--frozen-lockfile',
          '--lockfile-only',
          '--ignore-scripts'
        ],
        cwd: scratch,
        timeoutMs: 300_000
      })

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
    } finally {
      removeTreeSync(scratch)
    }
    // The 300s spawn budget is only reachable if the case is allowed to take it;
    // config/vitest.config.ts caps every case at 30s by default.
  }, 300_000)

  /**
   * `--lockfile-only` resolves; it never applies a patch. So the case above is
   * bounded to hash consistency, and the actual question -- can pnpm still put
   * the patched reader on disk? -- had nothing covering it.
   *
   * One package, patch applied for real, assert the marker landed. Scoped to the
   * single dependency so it stays a ~2s check rather than a full install.
   */
  it('materializes the patched command-line reader on a real install', () => {
    const pnpm = resolvePnpmInvocation()
    expect(pnpm, 'pnpm must be installed; it is the only thing that can check this').not.toBeNull()

    const scratch = mkdtempSync(join(tmpdir(), 'orca-patch-apply-'))
    try {
      mkdirSync(join(scratch, 'config', 'patches'), { recursive: true })
      copyFileSync(
        join(PROJECT_DIR, 'config', 'patches', WINDOWS_PROCESS_TREE_PATCH),
        join(scratch, 'config', 'patches', WINDOWS_PROCESS_TREE_PATCH)
      )
      writeFileSync(
        join(scratch, 'package.json'),
        `${JSON.stringify(
          {
            name: 'orca-patch-apply-probe',
            version: '1.0.0',
            dependencies: { '@vscode/windows-process-tree': '0.8.0' }
          },
          null,
          2
        )}\n`
      )
      writeFileSync(
        join(scratch, 'pnpm-workspace.yaml'),
        'packages: []\n' +
          'patchedDependencies:\n' +
          `  '@vscode/windows-process-tree@0.8.0': config/patches/${WINDOWS_PROCESS_TREE_PATCH}\n`
      )

      const result = runProcessSync({
        program: pnpm.program,
        args: [...pnpm.prefixArgs, 'install', '--no-frozen-lockfile', '--ignore-scripts'],
        cwd: scratch,
        timeoutMs: 300_000
      })
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)

      const materialized = readFileSync(
        join(
          scratch,
          'node_modules',
          '@vscode',
          'windows-process-tree',
          'src',
          'process_commandline.cc'
        ),
        'utf8'
      )
      expect(materialized).toContain('kProcessCommandLineInformation')
      // The whole point of the patch: the upstream reader is gone, not merely
      // supplemented.
      expect(materialized).not.toContain('ReadProcessMemory')
    } finally {
      removeTreeSync(scratch)
    }
  }, 300_000)
})

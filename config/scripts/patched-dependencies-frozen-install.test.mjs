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
import { runProcessSync } from '@orca/process-host'
import { resolveCliCommand } from '../../src/shared/node-cli-command-resolution.ts'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'
import { workspacePackageManifests } from './workspace-source-exports.mjs'

// Run actual pnpm: it hashes LF-normalized patch content; repeated raw SHA checks agreed with a bad CRLF lockfile and missed frozen-install failures.
// lockfile-only/ignore-scripts checks resolution without node_modules or native builds; patch application is tested separately below.
const PROJECT_DIR = resolve(import.meta.dirname, '../..')
const WINDOWS_PROCESS_TREE_PATCH = '@vscode__windows-process-tree@0.8.0.patch'
const CLAUDE_SDK_PATCH = '@anthropic-ai__claude-agent-sdk@0.3.284.patch'

// Use pnpm-cli-invocation’s Windows shim resolver; omit shell because runProcessSync rejects it and handles interpreter routing itself.
function resolvePnpmInvocation() {
  const { command, prefixArgs } = resolvePnpmCliInvocation()
  if (isAbsolute(command)) {
    return existsSync(command) ? { program: command, prefixArgs } : null
  }
  // Without npm_execpath, use bare extensionless name so shared resolver can try every executable form.
  const resolved = resolveCliCommand(parse(command).name)
  return isAbsolute(resolved) ? { program: resolved, prefixArgs } : null
}

describe('patched dependencies', () => {
  it('installs with --frozen-lockfile, which is what validates every patch hash', () => {
    const pnpm = resolvePnpmInvocation()
    expect(pnpm, 'pnpm must be installed; it is the only thing that can check this').not.toBeNull()

    // Use a copy: even frozen-lockfile rewrites untracked lockfile sections; preserve repository bytes.
    const scratch = mkdtempSync(join(tmpdir(), 'orca-frozen-install-'))
    try {
      for (const file of [
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        // The lockfile pins its checksum, so a frozen install fails without it.
        'config/pnpmfile.cjs',
        ...workspacePackageManifests(PROJECT_DIR)
      ]) {
        mkdirSync(resolve(scratch, file, '..'), { recursive: true })
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
    // Allow the full 300s spawn budget beyond Vitest’s 30s case default.
  }, 300_000)

  // Lockfile-only never applies patches; materialize the native reader and SDK in one minimal install.
  it('materializes the patched command-line reader and SDK runtime/declarations on a real install', () => {
    const pnpm = resolvePnpmInvocation()
    expect(pnpm, 'pnpm must be installed; it is the only thing that can check this').not.toBeNull()

    const scratch = mkdtempSync(join(tmpdir(), 'orca-patch-apply-'))
    try {
      mkdirSync(join(scratch, 'config', 'patches'), { recursive: true })
      for (const patch of [WINDOWS_PROCESS_TREE_PATCH, CLAUDE_SDK_PATCH]) {
        copyFileSync(
          join(PROJECT_DIR, 'config', 'patches', patch),
          join(scratch, 'config', 'patches', patch)
        )
      }
      writeFileSync(
        join(scratch, 'package.json'),
        `${JSON.stringify(
          {
            name: 'orca-patch-apply-probe',
            version: '1.0.0',
            dependencies: {
              '@vscode/windows-process-tree': '0.8.0',
              '@anthropic-ai/claude-agent-sdk': '0.3.284'
            }
          },
          null,
          2
        )}\n`
      )
      writeFileSync(
        join(scratch, 'pnpm-workspace.yaml'),
        'packages: []\n' +
          'patchedDependencies:\n' +
          `  '@vscode/windows-process-tree@0.8.0': config/patches/${WINDOWS_PROCESS_TREE_PATCH}\n` +
          `  '@anthropic-ai/claude-agent-sdk@0.3.284': config/patches/${CLAUDE_SDK_PATCH}\n`
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
      // Require upstream reader removal, not merely a supplementary patched reader.
      expect(materialized).not.toContain('ReadProcessMemory')
      const sdk = join(scratch, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
      for (const file of ['sdk.mjs', 'sdk.d.ts']) {
        const materializedSdk = readFileSync(join(sdk, file), 'utf8')
        expect(materializedSdk).toContain('processReceiveLifecycle')
        expect(materializedSdk).toContain('receiveCompleted')
      }
    } finally {
      removeTreeSync(scratch)
    }
  }, 300_000)
})

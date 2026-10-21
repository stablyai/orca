import { runProcessSync } from '@orca/process-host'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const BUILD_OUTPUT = join(
  REPO_ROOT,
  'native',
  'windows-agent-hook',
  '.build',
  'orca-agent-hook.exe'
)

let built = false

/**
 * The real orca-agent-hook.exe the package ships. CI builds it before the Windows lane, so the build
 * script's fingerprint makes this a read-only check there; a local run builds it on first use.
 * Suites copy it before running it, so no hook ever maps the shared output.
 */
export function buildWindowsNativeHookExecutable(): string {
  if (!built) {
    const result = runProcessSync({
      program: process.execPath,
      args: [join(REPO_ROOT, 'config', 'scripts', 'build-windows-agent-hook.mjs')],
      cwd: REPO_ROOT,
      timeoutMs: 300_000
    })
    if (result.code !== 0) {
      throw new Error(`orca-agent-hook.exe build failed:\n${result.stdout}\n${result.stderr}`)
    }
    built = true
  }
  return BUILD_OUTPUT
}

// A cold cargo build links from scratch, far past Vitest's default hook budget.
export const WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS = 300_000

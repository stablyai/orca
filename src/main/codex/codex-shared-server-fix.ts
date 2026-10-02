import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import {
  CODEX_DISABLE_SHARED_SERVER_ARGS,
  CODEX_SHARED_SERVER_FEATURE_KEY,
  CODEX_STOP_SHARED_SERVER_ARGS
} from '../../shared/codex-shared-server-command'
import { probeCodexSharedServer } from './codex-shared-server-probe'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'

const COMMAND_TIMEOUT_MS = 15_000
// Why longer: Codex lets running turns drain for up to 60 s by default, then forces after 10 s.
const STOP_TIMEOUT_MS = 75_000
const MAX_OUTPUT_BYTES = 64 * 1024

/**
 * The Codex CLI Codex installed under this home's `packages/` (the server's
 * package, else the legacy standalone one), so its lifecycle commands match
 * the server's version rather than whatever `codex` is on PATH.
 */
export async function resolveCodexSharedServerBinary(codexHome: string): Promise<string | null> {
  const fileName = process.platform === 'win32' ? 'codex.exe' : 'codex'
  for (const packageName of ['app-server-daemon', 'standalone']) {
    const current = join(codexHome, 'packages', packageName, 'current')
    for (const candidate of [join(current, 'bin', fileName), join(current, fileName)]) {
      try {
        if ((await stat(candidate)).isFile()) {
          return candidate
        }
      } catch {
        // Not installed in this layout.
      }
    }
  }
  return null
}

/** The command's stdout when it exited 0 in time; otherwise null. */
async function runCodex(
  codexHome: string,
  args: readonly string[],
  timeoutMs: number
): Promise<string | null> {
  const program = await resolveCodexSharedServerBinary(codexHome)
  if (!program) {
    return null
  }
  try {
    const result = await runProcess({
      program,
      args,
      // Why: the program's own folder exists whenever it resolved.
      cwd: dirname(program),
      env: { ...process.env, CODEX_HOME: codexHome },
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES
    })
    return result.code === 0 && !result.timedOut ? result.stdout : null
  } catch {
    return null
  }
}

/** Codex's `features list` row for `key`: `name  stage  true|false`. */
export function readFeatureEnabled(stdout: string, key: string): boolean | null {
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (columns[0] === key) {
      const enabled = columns.at(-1)
      return enabled === 'true' ? true : enabled === 'false' ? false : null
    }
  }
  return null
}

/**
 * Turns off server sharing in the pane's own home; true only once Codex reads
 * it back as off. Orca promotes the change from its mirror home to ~/.codex.
 */
export async function disableCodexSharedServerAutoStart(codexHome: string): Promise<boolean> {
  if ((await runCodex(codexHome, CODEX_DISABLE_SHARED_SERVER_ARGS, COMMAND_TIMEOUT_MS)) === null) {
    return false
  }
  // Why read back: managed config can pin the feature on even when the write exits 0.
  const list = await runCodex(codexHome, ['features', 'list'], COMMAND_TIMEOUT_MS)
  return list !== null && readFeatureEnabled(list, CODEX_SHARED_SERVER_FEATURE_KEY) === false
}

/**
 * Turn off for a pane on Orca's mirror home. The pass before records the key in
 * the promotion baseline (an older Orca's baseline lacks it, which would keep
 * the write as a conflict); the pass after promotes the write to ~/.codex.
 */
export async function disableCodexSharedServerAutoStartOnOrcaMirror(
  mirrorHome: string
): Promise<boolean> {
  syncOrcaMirrorBestEffort()
  const off = await disableCodexSharedServerAutoStart(mirrorHome)
  syncOrcaMirrorBestEffort()
  return off
}

/** The mirror pass a terminal launch runs; its outcome is reported by the sync itself. */
function syncOrcaMirrorBestEffort(): void {
  try {
    syncSystemConfigIntoManagedCodexHome()
  } catch (error) {
    // Why: the write alone still fixes Orca's tabs; ~/.codex then catches up at the next launch.
    console.warn('[codex-shared-server] mirror sync around Turn off failed:', error)
  }
}

/** Stops this home's shared server; true only once it is proven gone. */
export async function stopCodexSharedServer(codexHome: string): Promise<boolean> {
  // Why the probe decides: only it shows whether this home's server is actually gone.
  await runCodex(codexHome, CODEX_STOP_SHARED_SERVER_ARGS, STOP_TIMEOUT_MS)
  return (await probeCodexSharedServer(codexHome)) === 'absent'
}

import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import {
  CODEX_DISABLE_SHARED_SERVER_ARGS,
  CODEX_SHARED_SERVER_FEATURE_KEY,
  CODEX_STOP_SHARED_SERVER_ARGS
} from '../../shared/codex-shared-server-command'
import { probeCodexSharedServer } from './codex-shared-server-probe'

const COMMAND_TIMEOUT_MS = 15_000
// Allow the default 60-second turn drain plus 10 seconds for forced shutdown.
const STOP_TIMEOUT_MS = 75_000
const MAX_OUTPUT_BYTES = 64 * 1024

/** Use the installed server version for lifecycle commands. */
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

/** Codex features list columns: name, stage, enabled. */
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

export async function disableCodexSharedServerAutoStart(codexHome: string): Promise<boolean> {
  if ((await runCodex(codexHome, CODEX_DISABLE_SHARED_SERVER_ARGS, COMMAND_TIMEOUT_MS)) === null) {
    return false
  }
  // Managed config can keep the feature enabled after a successful write.
  const list = await runCodex(codexHome, ['features', 'list'], COMMAND_TIMEOUT_MS)
  return list !== null && readFeatureEnabled(list, CODEX_SHARED_SERVER_FEATURE_KEY) === false
}

export async function stopCodexSharedServer(codexHome: string): Promise<boolean> {
  // A successful stop command alone does not prove the server is gone.
  await runCodex(codexHome, CODEX_STOP_SHARED_SERVER_ARGS, STOP_TIMEOUT_MS)
  return (await probeCodexSharedServer(codexHome)) === 'absent'
}

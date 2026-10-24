import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'

const TCC_COMMAND_TIMEOUT_MS = 10_000

export type MacosTccResetResult = { ok: true } | { ok: false; detail: string }

/** PlistBuddy handles both binary and XML Info.plist encodings. */
export async function readMacosBundleId(appBundlePath: string): Promise<string | null> {
  try {
    const result = await runProcess({
      program: '/usr/libexec/PlistBuddy',
      args: ['-c', 'Print :CFBundleIdentifier', join(appBundlePath, 'Contents', 'Info.plist')],
      timeoutMs: TCC_COMMAND_TIMEOUT_MS
    })
    if (result.code !== 0) {
      return null
    }
    return result.stdout.trim() || null
  } catch {
    return null
  }
}

/** Return tccutil failures as data; unregistered bundles commonly exit 64. */
export async function resetMacosTccPermission(
  service: string,
  bundleId: string
): Promise<MacosTccResetResult> {
  let result: ProcessResult
  try {
    result = await runProcess({
      program: '/usr/bin/tccutil',
      args: ['reset', service, bundleId],
      timeoutMs: TCC_COMMAND_TIMEOUT_MS
    })
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'tccutil failed to start' }
  }
  if (result.code === 0) {
    return { ok: true }
  }
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code ?? 'unknown'}`
  return { ok: false, detail }
}

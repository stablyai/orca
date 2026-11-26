import { readFile } from 'node:fs/promises'
import { resolveBundledWindowsNativeHookExecutable } from '../commands/windows-native-hook-executable'
import { refreshManagedScriptIfPresent, restoreManagedScript } from './managed-hook-script-refresh'

/**
 * Copies the bundled bytes unchanged to preserve Authenticode. `createMissing` is only for
 * callers whose own install proves ownership; a locked or missing copy keeps their fallback.
 */
export async function publishBundledWindowsNativeHookExecutable(
  destination: string,
  options: { createMissing: boolean }
): Promise<void> {
  const source = resolveBundledWindowsNativeHookExecutable()
  if (!source) {
    return
  }
  try {
    const bytes = await readFile(source)
    await (options.createMissing
      ? restoreManagedScript(destination, bytes, { moveLockedTargetAside: true })
      : refreshManagedScriptIfPresent(destination, bytes, { moveLockedTargetAside: true }))
  } catch {
    // Locked executable and aside files can block replacement.
  }
}

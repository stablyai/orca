import { CURSOR_EVENTS } from './hook-events'
import { getWindowsCursorWrapperScript, getWindowsCursorWrapperScriptPath } from './hook-script'
import { getSharedManagedScriptPath } from '../agent-hooks/installation/scripts/managed-hook-script-path'
import {
  refreshManagedScriptIfPresent,
  scriptStillExists
} from '../agent-hooks/installation/scripts/managed-hook-script-refresh'
import { writeManagedScript } from '../agent-hooks/installation/scripts/managed-hook-script-write'
import { publishBundledWindowsNativeHookExecutable } from '../agent-hooks/installation/scripts/windows-native-hook-publish'
import { WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME } from '../agent-hooks/installation/commands/windows-native-hook-executable'

function publishNativeHook(): void {
  publishBundledWindowsNativeHookExecutable(
    getSharedManagedScriptPath(WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME),
    { createMissing: true }
  )
}

/** Keeps each registered event's wrapper in step with this build. */
export async function refreshWindowsCursorWrapperScripts(coreScriptPath: string): Promise<void> {
  // Only repair an install that exists: Cursor desktop runs without the CLI that gates install().
  if (process.platform !== 'win32' || !(await scriptStillExists(coreScriptPath))) {
    return
  }
  publishNativeHook()
  for (const event of CURSOR_EVENTS) {
    await refreshManagedScriptIfPresent(
      getWindowsCursorWrapperScriptPath(event),
      getWindowsCursorWrapperScript(event)
    )
  }
}

/** Hook entries must never point at a wrapper the install has not written yet. */
export function writeWindowsCursorWrapperScripts(): void {
  if (process.platform !== 'win32') {
    return
  }
  publishNativeHook()
  for (const event of CURSOR_EVENTS) {
    writeManagedScript(
      getWindowsCursorWrapperScriptPath(event),
      getWindowsCursorWrapperScript(event)
    )
  }
}

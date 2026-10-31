import { execFile } from 'node:child_process'
import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'
import { reportComputerDiagnostic } from './computer-sidecar-diagnostics'
import { RuntimeClientError } from './runtime-client-error'
import type { DesktopScriptPlatform } from './desktop-script-provider-paths'
import {
  FALLBACK_WINDOWS_EXECUTION_POLICY,
  PREFERRED_WINDOWS_EXECUTION_POLICY,
  isExecutionPolicyBlocked,
  windowsPowerShellRuntimeArgs
} from './windows-powershell-execution-policy'

const REQUEST_TIMEOUT_MS = 30_000
const FORCE_KILL_GRACE_MS = 1_000

export async function execBridge(
  platform: DesktopScriptPlatform,
  scriptPath: string,
  operationPath: string
): Promise<{ stdout: string; stderr: string }> {
  if (platform !== 'windows') {
    return await mapped(runBridgeProcess('python3', [scriptPath, operationPath]))
  }
  const command = windowsPowerShellPath()
  try {
    return await runBridgeProcess(
      command,
      windowsPowerShellRuntimeArgs(scriptPath, PREFERRED_WINDOWS_EXECUTION_POLICY, [operationPath])
    )
  } catch (error) {
    if (!isPolicyBlockedStart(error)) {
      throw error instanceof BridgeProcessFailure ? error.mapped : error
    }
    reportComputerDiagnostic(
      `bridge start blocked at ${PREFERRED_WINDOWS_EXECUTION_POLICY}; retrying once with ${FALLBACK_WINDOWS_EXECUTION_POLICY}`
    )
    return await mapped(
      runBridgeProcess(
        command,
        windowsPowerShellRuntimeArgs(scriptPath, FALLBACK_WINDOWS_EXECUTION_POLICY, [operationPath])
      )
    )
  }
}

async function mapped(
  run: Promise<{ stdout: string; stderr: string }>
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run
  } catch (error) {
    throw error instanceof BridgeProcessFailure ? error.mapped : error
  }
}

/** Retry policy failures with empty stdout; a post-action crash can also leave stdout empty. */
function isPolicyBlockedStart(error: unknown): error is BridgeProcessFailure {
  return (
    error instanceof BridgeProcessFailure &&
    !error.stdout.trim() &&
    isExecutionPolicyBlocked(error.stderr)
  )
}

/** Preserve raw streams so policy classification does not depend on a mapped error message. */
class BridgeProcessFailure extends Error {
  constructor(
    readonly stdout: string,
    readonly stderr: string,
    readonly mapped: RuntimeClientError
  ) {
    super(mapped.message)
    this.name = 'BridgeProcessFailure'
  }
}

function runBridgeProcess(
  command: string,
  args: readonly string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof execFile> | null = null
    let settled = false
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null

    const clearForceKillTimer = (): void => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
        forceKillTimer = null
      }
    }

    const finish = (
      error: Error | null,
      result?: { stdout: string; stderr: string },
      options: { keepForceKillTimer?: boolean } = {}
    ): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (!options.keepForceKillTimer) {
        clearForceKillTimer()
      }
      if (error) {
        reject(error)
        return
      }
      resolve(result ?? { stdout: '', stderr: '' })
    }

    // Native automation can hang; reject promptly and escalate if graceful termination fails.
    const timeout = setTimeout(() => {
      child?.kill('SIGTERM')
      forceKillTimer = setTimeout(() => {
        child?.kill('SIGKILL')
        forceKillTimer = null
      }, FORCE_KILL_GRACE_MS)
      finish(
        new RuntimeClientError(
          'action_timeout',
          `desktop provider timed out after ${REQUEST_TIMEOUT_MS}ms`
        ),
        undefined,
        { keepForceKillTimer: true }
      )
    }, REQUEST_TIMEOUT_MS)

    try {
      child = execFile(
        command,
        [...args],
        {
          env: process.env,
          maxBuffer: 20 * 1024 * 1024,
          timeout: REQUEST_TIMEOUT_MS,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (error) {
            const message = stderr.trim() || stdout.trim() || error.message
            const mapped = error.killed
              ? new RuntimeClientError('action_timeout', message)
              : mapBridgeError(message)
            finish(new BridgeProcessFailure(stdout, stderr, mapped))
            return
          }
          finish(null, { stdout, stderr })
        }
      )
      child?.once('exit', clearForceKillTimer)
    } catch (error) {
      finish(mapBridgeError(error instanceof Error ? error.message : String(error)))
    }
  })
}

export function mapBridgeError(message: string): RuntimeClientError {
  const text = message.trim() || 'desktop provider failed'
  if (/text_input_incomplete/i.test(text)) {
    return new RuntimeClientError('action_timeout', text)
  }
  if (/appNotFound|app not found/i.test(text)) {
    return new RuntimeClientError('app_not_found', text)
  }
  if (/appBlocked|app blocked/i.test(text)) {
    return new RuntimeClientError('app_blocked', text)
  }
  if (
    /unsupported capability|hotkey.*require|paste_text requires|modified clicks require xdotool|GDK is required for non-character key synthesis/i.test(
      text
    )
  ) {
    return new RuntimeClientError('unsupported_capability', text)
  }
  if (
    /unsupported mouse button|unsupported scroll direction|unsupported (?:key|modifier)|windowId is not supported|must be a positive|must be a finite number|\b(?:x|y|from_x|from_y|to_x|to_y|pages|click_count|text|key|direction) is required\b/i.test(
      text
    )
  ) {
    return new RuntimeClientError('invalid_argument', text)
  }
  if (/ModuleNotFoundError: No module named 'gi'|PyGObject|python3-gi/i.test(text)) {
    const interpreter = /PyGObject unavailable in interpreter: (.+)/.exec(text)?.[1]?.trim()
    return new RuntimeClientError(
      'unsupported_capability',
      interpreter
        ? `Linux Computer Use requires python3-gi and AT-SPI packages, which the python3 it ran (${interpreter}) cannot load. Install python3-gi gir1.2-atspi-2.0 at-spi2-core for that interpreter, or put a python3 that has them (usually /usr/bin/python3) first on PATH, then retry.`
        : 'Linux Computer Use requires python3-gi and AT-SPI packages. Install python3-gi gir1.2-atspi-2.0 at-spi2-core, then retry.'
    )
  }
  if (/spawn python3 ENOENT/.test(text)) {
    return new RuntimeClientError(
      'unsupported_capability',
      "Computer use isn't available on this host: Linux Computer Use runs python3, and none is on PATH. Install python3 with python3-gi gir1.2-atspi-2.0 at-spi2-core, then retry."
    )
  }
  if (/not a valid secondary action|action.*not supported/i.test(text)) {
    return new RuntimeClientError('action_not_supported', text)
  }
  if (/value is not settable|not settable/i.test(text)) {
    return new RuntimeClientError('value_not_settable', text)
  }
  if (/stale element|fresh element index/i.test(text)) {
    return new RuntimeClientError('element_not_found', text)
  }
  if (/windowStale|window stale/i.test(text)) {
    return new RuntimeClientError('window_stale', text)
  }
  if (
    /window_not_focused|keyboard input requires.*window.*focused|target window.*focused/i.test(text)
  ) {
    return new RuntimeClientError('window_not_focused', text)
  }
  if (/screenshot_failed|screenshot.*failed|screen recording|payload cap/i.test(text)) {
    return new RuntimeClientError('screenshot_failed', text)
  }
  if (
    /window_not_found|No top-level(?: AT-SPI| UI Automation)? window|has no (?:on-screen |accessibility )?window|could not match accessibility window|unknown window(?:_index| id)?/i.test(
      text
    )
  ) {
    return new RuntimeClientError('window_not_found', text)
  }
  if (/permission|desktop session|DBUS|XDG_RUNTIME_DIR|AT-SPI/i.test(text)) {
    return new RuntimeClientError('permission_denied', text)
  }
  if (
    /element_not_found|stale element|fresh element index|unknown element_index|element \d+ is stale|element indexes require|element \d+ changed since|element \d+ is not in the current cached snapshot/i.test(
      text
    )
  ) {
    return new RuntimeClientError('element_not_found', text)
  }
  return new RuntimeClientError('accessibility_error', text)
}

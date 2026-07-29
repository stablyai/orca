import { EmulatorError } from '../emulator-errors'
import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { ensureAdbOk } from './android-adb-result'
import { installApkArgs, launchAppArgs } from './android-app-control'
import { permissionArgs, type AndroidPermissionOp } from './android-permissions'
import { logcatArgs, parseLogcatLine, type LogcatEntry } from './android-logcat'
import { parseUiAutomatorXml, type AndroidAxNode } from './uiautomator-tree'

// Impure capability operations: compose the pure arg-builders/parsers with the
// command runner. The backend exposes thin delegations to these.

const UIAUTOMATOR_DUMP_PATH = '/sdcard/window_dump.xml'

export async function installAndroidApk(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  serial: string,
  apkPath: string,
  options?: { reinstall?: boolean }
): Promise<void> {
  const result = await runner(sdk.adb, installApkArgs(serial, apkPath, options))
  // adb install can exit 0 while printing "Failure [...]" to stdout.
  if (result.code !== 0 || /Failure|Error/i.test(`${result.stdout}${result.stderr}`)) {
    throw new EmulatorError(
      'emulator_error',
      `adb install failed: ${(result.stderr || result.stdout).trim() || 'unknown error'}`
    )
  }
}

export async function launchAndroidApp(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  serial: string,
  packageName: string,
  activity?: string
): Promise<void> {
  ensureAdbOk(await runner(sdk.adb, launchAppArgs(serial, packageName, activity)), 'adb launch')
}

export async function setAndroidPermission(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  serial: string,
  op: AndroidPermissionOp,
  packageName: string,
  permission?: string
): Promise<void> {
  ensureAdbOk(
    await runner(sdk.adb, permissionArgs(serial, op, packageName, permission)),
    'adb permission'
  )
}

export async function dumpAndroidAccessibilityTree(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  serial: string
): Promise<AndroidAxNode> {
  // uiautomator dump writes XML to a device file; read it back and parse. Check
  // the dump first — otherwise `cat` can return a stale file from a prior dump.
  ensureAdbOk(
    await runner(sdk.adb, ['-s', serial, 'shell', 'uiautomator', 'dump', UIAUTOMATOR_DUMP_PATH]),
    'uiautomator dump'
  )
  const xml = ensureAdbOk(
    await runner(sdk.adb, ['-s', serial, 'shell', 'cat', UIAUTOMATOR_DUMP_PATH]),
    'read ui dump'
  )
  return parseUiAutomatorXml(xml.stdout)
}

export async function captureAndroidLogcat(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  serial: string,
  options?: { lines?: number; filters?: readonly string[] }
): Promise<LogcatEntry[]> {
  // One-shot dump for a request/response RPC; follow-mode would need streaming.
  const result = ensureAdbOk(
    await runner(sdk.adb, logcatArgs(serial, { ...options, dump: true })),
    'adb logcat'
  )
  return result.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parseLogcatLine)
}

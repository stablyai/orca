import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { platform } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import type { EmulatorSetupActionResult } from '../../shared/emulator-setup-types'
import { inspectIosSetupFromHost } from './emulator-setup-host-probe'

const execFileAsync = promisify(execFile)

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function quoteAppleScript(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function xcodeSignatureCheck(xcodebuild: string): string {
  const requirement = '-R=anchor apple and identifier "com.apple.dt.xcodebuild"'
  return `/usr/bin/codesign --verify --strict ${quoteShell(requirement)} ${quoteShell(xcodebuild)}`
}

async function runPrivilegedCommand(command: string): Promise<void> {
  await execFileAsync('/usr/bin/osascript', [
    '-e',
    `do shell script ${quoteAppleScript(command)} with administrator privileges`
  ])
}

type XcodeSetupActionDependencies = {
  platform: NodeJS.Platform
  realpath: (path: string) => Promise<string>
  exists: (path: string) => boolean
  inspect: typeof inspectIosSetupFromHost
  verifyXcode: (appPath: string) => Promise<void>
  runPrivileged: (command: string) => Promise<void>
}

async function verifyAppleXcode(appPath: string): Promise<void> {
  try {
    await execFileAsync('/usr/bin/codesign', [
      '--verify',
      '--strict',
      '-R=anchor apple and identifier "com.apple.dt.xcodebuild"',
      join(appPath, 'Contents', 'Developer', 'usr', 'bin', 'xcodebuild')
    ])
  } catch {
    throw new Error('Orca could not verify this copy of Xcode. Reinstall Xcode and try again.')
  }
}

const defaultDependencies: XcodeSetupActionDependencies = {
  platform: platform(),
  realpath,
  exists: existsSync,
  inspect: inspectIosSetupFromHost,
  verifyXcode: verifyAppleXcode,
  runPrivileged: runPrivilegedCommand
}

async function validateDeveloperDir(
  developerDir: string,
  dependencies: XcodeSetupActionDependencies
): Promise<string> {
  if (dependencies.platform !== 'darwin') {
    throw new Error('Xcode setup is available only on macOS.')
  }
  const normalized = normalize(developerDir)
  if (!normalized.endsWith('.app/Contents/Developer')) {
    throw new Error('The selected Xcode developer folder is invalid.')
  }
  const canonical = await dependencies.realpath(normalized)
  if (!dependencies.exists(join(canonical, 'usr', 'bin', 'xcodebuild'))) {
    throw new Error('The selected app does not contain the full Xcode toolchain.')
  }
  await dependencies.verifyXcode(dirname(dirname(canonical)))
  const status = await dependencies.inspect()
  if (!status.installedXcodes.some((xcode) => xcode.developerDir === normalized)) {
    throw new Error('Xcode is no longer installed at the detected location. Refresh and try again.')
  }
  return canonical
}

function actionFailure(error: unknown): EmulatorSetupActionResult {
  const message = error instanceof Error ? error.message : 'Xcode setup failed.'
  const canceled = /-128|user canceled|user cancelled/i.test(message)
  return {
    ok: false,
    canceled,
    message: canceled ? 'Administrator authorization was canceled.' : message
  }
}

export function createXcodeSetupActions(
  dependencies: XcodeSetupActionDependencies = defaultDependencies
) {
  return {
    async useInstalledXcode(developerDir: string): Promise<EmulatorSetupActionResult> {
      try {
        const canonical = await validateDeveloperDir(developerDir, dependencies)
        const xcodebuild = join(canonical, 'usr', 'bin', 'xcodebuild')
        await dependencies.runPrivileged(
          `${xcodeSignatureCheck(xcodebuild)} && /usr/bin/xcode-select --switch ${quoteShell(canonical)} && ${quoteShell(xcodebuild)} -runFirstLaunch`
        )
        return { ok: true }
      } catch (error) {
        return actionFailure(error)
      }
    },
    async finishXcodeSetup(developerDir: string): Promise<EmulatorSetupActionResult> {
      try {
        const canonical = await validateDeveloperDir(developerDir, dependencies)
        const xcodebuild = join(canonical, 'usr', 'bin', 'xcodebuild')
        await dependencies.runPrivileged(
          `${xcodeSignatureCheck(xcodebuild)} && ${quoteShell(xcodebuild)} -runFirstLaunch`
        )
        return { ok: true }
      } catch (error) {
        return actionFailure(error)
      }
    }
  }
}

const defaultActions = createXcodeSetupActions()
export const useInstalledXcode = defaultActions.useInstalledXcode
export const finishXcodeSetup = defaultActions.finishXcodeSetup

export async function resolveInstalledXcodeAppPath(developerDir: string): Promise<string> {
  return dirname(dirname(await validateDeveloperDir(developerDir, defaultDependencies)))
}

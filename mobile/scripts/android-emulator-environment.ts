// Why: locating the Android SDK, the AVD store and a booted device is the part of
// an Android repro that silently goes wrong, so it is pure and unit-tested here
// while start-android-emulator.ts keeps only the process spawning.
import path from 'node:path'

export type AndroidEnvironment = {
  readonly env: NodeJS.ProcessEnv
  readonly homeDir: string
  readonly platform: NodeJS.Platform
}

export type AndroidTool = 'adb' | 'emulator' | 'avdmanager'

const TOOL_DIRECTORIES: Record<AndroidTool, readonly string[]> = {
  adb: ['platform-tools'],
  emulator: ['emulator'],
  avdmanager: ['cmdline-tools', 'latest', 'bin']
}

// Why: avdmanager ships as a shell wrapper, so Windows needs the .bat sibling
// while the native binaries need .exe.
const WINDOWS_TOOL_SUFFIX: Record<AndroidTool, string> = {
  adb: '.exe',
  emulator: '.exe',
  avdmanager: '.bat'
}

function defaultSdkRoot({ homeDir, platform, env }: AndroidEnvironment): string {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA
    return localAppData
      ? path.join(localAppData, 'Android', 'Sdk')
      : path.join(homeDir, 'AppData', 'Local', 'Android', 'Sdk')
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Android', 'sdk')
  }
  return path.join(homeDir, 'Android', 'Sdk')
}

export function resolveAndroidSdkRoot(environment: AndroidEnvironment): string {
  const { env } = environment
  return env.ANDROID_HOME || env.ANDROID_SDK_ROOT || defaultSdkRoot(environment)
}

// Why: recent avdmanager writes AVDs under $XDG_CONFIG_HOME/.android while the
// emulator still defaults to ~/.android, so a freshly created AVD is invisible
// unless both sides are pointed at the same root. ANDROID_EMULATOR_HOME is the
// emulator's own override for that directory (`emulator -help-environment`).
export function resolveAndroidAvdHome({ env, homeDir }: AndroidEnvironment): string {
  if (env.ANDROID_AVD_HOME) {
    return env.ANDROID_AVD_HOME
  }
  // Why: an exported-but-empty override must fall through, not resolve to the
  // relative './avd' that `??` would produce.
  const androidHome =
    env.ANDROID_EMULATOR_HOME ||
    env.ANDROID_USER_HOME ||
    (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, '.android') : '')
  return path.join(androidHome || path.join(homeDir, '.android'), 'avd')
}

export function resolveAndroidToolPath(environment: AndroidEnvironment, tool: AndroidTool): string {
  const suffix = environment.platform === 'win32' ? WINDOWS_TOOL_SUFFIX[tool] : ''
  return path.join(
    resolveAndroidSdkRoot(environment),
    ...TOOL_DIRECTORIES[tool],
    `${tool}${suffix}`
  )
}

export function parseAvdNames(listAvdsStdout: string): string[] {
  return (
    listAvdsStdout
      .split('\n')
      .map((line) => line.trim())
      // Why: `emulator -list-avds` prefixes warnings with the binary name and can
      // emit blank lines; AVD names never contain whitespace.
      .filter((line) => line.length > 0 && !line.includes(' ') && !line.includes(':'))
  )
}

export function selectAvdName(avdNames: readonly string[], requested?: string): string | null {
  if (avdNames.length === 0) {
    return null
  }
  if (!requested) {
    return avdNames[0] ?? null
  }
  const exact = avdNames.find((name) => name === requested)
  if (exact) {
    return exact
  }
  const lowerRequested = requested.toLowerCase()
  return avdNames.find((name) => name.toLowerCase().includes(lowerRequested)) ?? null
}

export function findBootedEmulatorSerial(adbDevicesStdout: string): string | null {
  for (const line of adbDevicesStdout.split('\n')) {
    const [serial, state] = line.trim().split(/\s+/)
    // Why: `offline` and `unauthorized` entries appear while an emulator is still
    // coming up; only `device` accepts shell commands.
    if (serial?.startsWith('emulator-') && state === 'device') {
      return serial
    }
  }
  return null
}

// Why: `adb emu avd name` answers with the name followed by an OK acknowledgement,
// so the reused emulator can be matched against an explicitly requested AVD.
export function parseRunningAvdName(emuAvdNameStdout: string): string | null {
  const name = emuAvdNameStdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && line !== 'OK')
  return name ?? null
}

// Why: Gradle 9 fails `configureCMakeDebug` on JDK 24+ because the Android
// toolchain calls a restricted java.lang.System method that those runtimes deny.
const MAX_SUPPORTED_BUILD_JDK = 23

export function parseJavaMajorVersion(javaVersionOutput: string): number | null {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(javaVersionOutput)
  if (!match) {
    return null
  }
  const major = Number(match[1])
  // Why: Java 8 and earlier report as 1.x, so the minor field carries the major.
  return major === 1 ? Number(match[2] ?? 0) : major
}

export function describeBuildJdkSupport(majorVersion: number | null): string | null {
  if (majorVersion === null) {
    return 'Could not read a Java version; `expo run:android` needs a JDK on PATH.'
  }
  if (majorVersion < 17) {
    return `JDK ${majorVersion} is too old for the Android Gradle plugin; use JDK 17.`
  }
  if (majorVersion > MAX_SUPPORTED_BUILD_JDK) {
    return `JDK ${majorVersion} fails the Gradle CMake configure step; set JAVA_HOME to a JDK 17 build before \`expo run:android\`.`
  }
  return null
}

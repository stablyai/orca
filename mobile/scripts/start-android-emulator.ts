#!/usr/bin/env npx tsx
// Why: Orca Mobile bugs that only appear under an Android IME (#7427, #7495) kept
// stalling on "no Android device here" — start:emulator only drives the iOS
// simulator. This boots or reuses an AVD and reports the exact next command.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import {
  describeBuildJdkSupport,
  findBootedEmulatorSerial,
  parseAvdNames,
  parseJavaMajorVersion,
  parseRunningAvdName,
  resolveAndroidAvdHome,
  resolveAndroidSdkRoot,
  resolveAndroidToolPath,
  selectAvdName,
  type AndroidEnvironment
} from './android-emulator-environment'

const execFileAsync = promisify(execFile)

const BOOT_TIMEOUT_MS = 300_000
const BOOT_POLL_INTERVAL_MS = 2_000
// Why: Metro and the mock host both live on the developer's machine; reversing
// them means the guest reaches them on localhost, which keeps the pairing
// endpoint identical to a physical-device run.
const REVERSED_PORTS = [8081, 6768]

type CliOptions = {
  readonly avd?: string
  readonly noReverse: boolean
  readonly ports: readonly number[]
}

function parseArgs(argv: readonly string[]): CliOptions {
  const args = [...argv]
  let avd: string | undefined
  let noReverse = false
  const ports: number[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--avd' && index + 1 < args.length) {
      avd = args[++index]
    } else if (arg === '--no-reverse') {
      noReverse = true
    } else if (arg === '--port' && index + 1 < args.length) {
      const port = Number(args[++index])
      if (Number.isInteger(port) && port > 0) {
        ports.push(port)
      }
    }
  }
  return { avd, noReverse, ports: ports.length > 0 ? ports : REVERSED_PORTS }
}

function log(message: string): void {
  console.log(message)
}

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

const environment: AndroidEnvironment = {
  env: process.env,
  homeDir: os.homedir(),
  platform: process.platform
}

// Why: the emulator resolves AVDs from its own env, so reporting the XDG-aware
// path is not enough — every tool has to be pointed at the same store or
// `-list-avds` comes back empty for an AVD avdmanager just created.
const toolEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ANDROID_SDK_ROOT: resolveAndroidSdkRoot(environment),
  ANDROID_AVD_HOME: resolveAndroidAvdHome(environment)
}

async function readToolOutput(toolPath: string, args: readonly string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(toolPath, [...args], { env: toolEnv })
  return `${stdout}${stderr}`
}

async function reportBuildJdk(): Promise<void> {
  const javaBinary = process.platform === 'win32' ? 'java.exe' : 'java'
  const javaHome = process.env.JAVA_HOME
  const javaPath = javaHome ? path.join(javaHome, 'bin', javaBinary) : javaBinary
  const output = await readToolOutput(javaPath, ['-version']).catch(() => '')
  const advice = describeBuildJdkSupport(parseJavaMajorVersion(output))
  if (advice) {
    log(`  ! ${advice}`)
  }
}

function requireTool(tool: 'adb' | 'emulator'): string {
  const toolPath = resolveAndroidToolPath(environment, tool)
  if (!fs.existsSync(toolPath)) {
    fail(
      `${tool} not found at ${toolPath}.\n` +
        `  Set ANDROID_HOME, or install it with:\n` +
        `    sdkmanager --sdk_root="${resolveAndroidSdkRoot(environment)}" "platform-tools" "emulator"`
    )
  }
  return toolPath
}

async function bootEmulator(emulatorPath: string, avdName: string): Promise<void> {
  log(`▸ Booting AVD ${avdName}`)
  const child = spawn(emulatorPath, ['-avd', avdName, '-no-boot-anim'], {
    detached: true,
    env: toolEnv,
    stdio: 'ignore'
  })
  child.unref()
}

async function waitForBoot(adbPath: string, deadline: number): Promise<string> {
  while (Date.now() < deadline) {
    const devices = await readToolOutput(adbPath, ['devices']).catch(() => '')
    const serial = findBootedEmulatorSerial(devices)
    if (serial) {
      const booted = await readToolOutput(adbPath, [
        '-s',
        serial,
        'shell',
        'getprop',
        'sys.boot_completed'
      ]).catch(() => '')
      if (booted.trim() === '1') {
        return serial
      }
    }
    await new Promise((resolve) => setTimeout(resolve, BOOT_POLL_INTERVAL_MS))
  }
  fail('Timed out waiting for the emulator to finish booting.')
}

async function reversePorts(
  adbPath: string,
  serial: string,
  ports: readonly number[]
): Promise<void> {
  const reversed: number[] = []
  const failed: number[] = []
  for (const port of ports) {
    const ok = await execFileAsync(
      adbPath,
      ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`],
      { env: toolEnv }
    ).then(
      () => true,
      () => false
    )
    if (ok) {
      reversed.push(port)
    } else {
      failed.push(port)
    }
  }
  if (reversed.length > 0) {
    log(`▸ Reversed ports: ${reversed.join(', ')}`)
  }
  if (failed.length > 0) {
    log(`  ! could not reverse: ${failed.join(', ')}`)
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const adbPath = requireTool('adb')
  const emulatorPath = requireTool('emulator')

  log(`▸ SDK root: ${resolveAndroidSdkRoot(environment)}`)
  log(`▸ AVD home: ${resolveAndroidAvdHome(environment)}`)
  await reportBuildJdk()

  let serial = findBootedEmulatorSerial(await readToolOutput(adbPath, ['devices']).catch(() => ''))
  if (serial) {
    const runningAvd = parseRunningAvdName(
      await readToolOutput(adbPath, ['-s', serial, 'emu', 'avd', 'name']).catch(() => '')
    )
    // Why: startup matches case-insensitively on a substring, so reuse must too —
    // otherwise `--avd pixel` rejects the Pixel_7_API_36 it would have booted.
    if (options.avd && runningAvd && selectAvdName([runningAvd], options.avd) === null) {
      fail(
        `${serial} is running ${runningAvd}, not the requested ${options.avd}.\n` +
          `  Stop it first: adb -s ${serial} emu kill`
      )
    }
    log(`▸ Reusing running emulator ${serial}${runningAvd ? ` (${runningAvd})` : ''}`)
  } else {
    const avdNames = parseAvdNames(await readToolOutput(emulatorPath, ['-list-avds']))
    const avdName = selectAvdName(avdNames, options.avd)
    if (!avdName) {
      fail(
        (options.avd
          ? `No AVD matched "${options.avd}".`
          : 'No AVDs found. Create one with avdmanager, then re-run.') +
          (avdNames.length > 0 ? `\n  Available: ${avdNames.join(', ')}` : '') +
          `\n  AVDs are read from ${resolveAndroidAvdHome(environment)}.` +
          `\n  Create one with ${resolveAndroidToolPath(environment, 'avdmanager')}`
      )
    }
    await bootEmulator(emulatorPath, avdName)
    serial = await waitForBoot(adbPath, Date.now() + BOOT_TIMEOUT_MS)
  }

  if (!options.noReverse) {
    await reversePorts(adbPath, serial, options.ports)
  }

  log(`\n✔ Emulator ready: ${serial}\n`)
  log('Next:')
  log('  pnpm mock-server                # host stub, or run Orca desktop instead')
  log('  pnpm exec expo run:android      # build and install the dev client')
  log('  pnpm start --dev-client         # Metro\n')
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
})

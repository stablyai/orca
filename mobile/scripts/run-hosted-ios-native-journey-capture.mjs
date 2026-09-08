#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { resolveEmulatorOrcaCli } from './emulator-orca-cli-selection.mjs'
import { startHostedIosEmulatorController } from './hosted-ios-emulator-controller.mjs'
import { captureHostedIosNativeJourneyLabels } from './hosted-ios-native-journey-labels.mjs'
import { completeHostedIosNativeOnboarding } from './hosted-ios-native-onboarding.mjs'
import {
  startHostedIosMobileLauncher,
  waitForHostedIosMobileLauncher
} from './hosted-ios-mobile-launcher.mjs'
import { installHostedIosSimulatorApp } from './hosted-ios-simulator-app-build.mjs'
import {
  bootHostedIosSimulator,
  resolveHostedIosSimulatorUdid
} from './hosted-ios-simulator-device.mjs'
import { stopHostedChildProcess } from './hosted-child-process-shutdown.mjs'

const usage =
  'Usage: node scripts/run-hosted-ios-native-journey-capture.mjs --app <Orca.app> --out <dir> [--metro-dir <dir>] [--device <name>] [--timeout-ms <ms>]'

function parseOptions(argv) {
  const options = {
    appPath: null,
    device: 'iPhone 17 Pro',
    metroDirectory: null,
    outputDirectory: null,
    timeoutMs: 180_000
  }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--app' && argv[index + 1]) {
      options.appPath = path.resolve(argv[++index])
    } else if (argv[index] === '--out' && argv[index + 1]) {
      options.outputDirectory = path.resolve(argv[++index])
    } else if (argv[index] === '--metro-dir' && argv[index + 1]) {
      options.metroDirectory = path.resolve(argv[++index])
    } else if (argv[index] === '--device' && argv[index + 1]) {
      options.device = argv[++index]
    } else if (argv[index] === '--timeout-ms' && argv[index + 1]) {
      options.timeoutMs = Number(argv[++index])
    } else {
      throw new Error(`Unknown argument: ${argv[index]}\n${usage}`)
    }
  }
  if (!options.appPath || !options.outputDirectory) {
    throw new Error(usage)
  }
  return options
}

const worktree = path.resolve(import.meta.dirname, '../..')
const options = parseOptions(process.argv.slice(2))
const runtimeDirectory = path.join(options.outputDirectory, 'runtime')

async function main() {
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })
  const deviceUdid = await resolveHostedIosSimulatorUdid(options.device)
  await bootHostedIosSimulator(deviceUdid)
  await installHostedIosSimulatorApp({ deviceUdid, appPath: options.appPath })
  const orcaSelection = resolveEmulatorOrcaCli({
    explicitCommand: process.env.ORCA_CLI,
    managedCommand: process.env.ORCA_CLI_COMMAND,
    devRepoRoot: process.env.ORCA_DEV_REPO_ROOT,
    worktree,
    cwd: worktree
  })
  const controller = await startHostedIosEmulatorController({
    orcaCli: orcaSelection.command,
    runtimeDirectory,
    worktree
  })
  const launcher = startHostedIosMobileLauncher({
    deviceUdid,
    emulatorControlUserDataPath: controller.userData,
    metroDirectory: options.metroDirectory,
    orcaCli: orcaSelection.command,
    runtimeDirectory,
    worktree
  })
  try {
    await waitForHostedIosMobileLauncher(launcher, options.timeoutMs)
    const emulator = {
      deviceUdid,
      orcaCli: orcaSelection.command,
      userDataDir: controller.userData,
      worktree
    }
    const expectedWorkspace = path.basename(worktree)
    const onboarding = await completeHostedIosNativeOnboarding(
      emulator,
      expectedWorkspace,
      options.timeoutMs
    )
    const stops = await captureHostedIosNativeJourneyLabels({
      deviceUdid,
      emulator,
      expectedWorkspace,
      outputDirectory: options.outputDirectory,
      timeoutMs: options.timeoutMs
    })
    const evidence = {
      appPath: options.appPath,
      expectedWorkspace,
      metroDirectory: options.metroDirectory ?? path.join(worktree, 'mobile'),
      onboarding,
      stops
    }
    const evidencePath = path.join(options.outputDirectory, 'native-journey-capture.json')
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(evidencePath)
  } finally {
    await stopHostedChildProcess(launcher).catch(() => undefined)
    await controller.stop().catch(() => undefined)
  }
}

await main()

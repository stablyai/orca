#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const appImageArg = valueAfter('--appimage')
const appRunArg = valueAfter('--app-run')
const platform = valueAfter('--platform') ?? 'linux/amd64'
const expectFailure = args.includes('--expect-failure')
if (!appImageArg) {
  fail(
    'Usage: run-appimage-cli-sandbox-docker.mjs --appimage <path> [--app-run <path>] [--platform <linux platform>] [--expect-failure]'
  )
}

const appImage = resolve(appImageArg)
const appRun = appRunArg ? resolve(appRunArg) : null
if (!existsSync(appImage)) {
  fail(`AppImage not found: ${appImage}`)
}
if (appRun && !existsSync(appRun)) {
  fail(`AppRun not found: ${appRun}`)
}

const suffix = `${process.pid}-${Date.now()}`
const image = `orca-appimage-cli-sandbox:${suffix}`
const volume = `orca-appimage-cli-sandbox-${suffix}`
const dockerDirectory = resolve('config', 'docker', 'appimage-cli-sandbox')
const sha256 = createHash('sha256').update(readFileSync(appImage)).digest('hex')

try {
  docker(['build', '--platform', platform, '-t', image, dockerDirectory])
  docker(['volume', 'create', volume])
  const extractArgs = [
    'run',
    '--rm',
    '--platform',
    platform,
    '--entrypoint',
    'bash',
    '-v',
    `${appImage}:/input/orca.AppImage:ro`,
    '-v',
    `${volume}:/artifacts`,
    image,
    '-lc',
    '7z x /input/orca.AppImage -o/artifacts/root -y >/dev/null && chmod -R a+rX /artifacts/root'
  ]
  docker(extractArgs)
  if (appRun) {
    docker([
      'run',
      '--rm',
      '--platform',
      platform,
      '--entrypoint',
      'bash',
      '-v',
      `${appRun}:/input/AppRun:ro`,
      '-v',
      `${volume}:/artifacts`,
      image,
      '-lc',
      'cp /input/AppRun /artifacts/root/AppRun && chmod 755 /artifacts/root/AppRun'
    ])
  }

  console.log(
    JSON.stringify({ type: 'appimage_cli_sandbox_input', appImage, sha256, appRun, platform })
  )
  const result = docker(
    ['run', '--rm', '--platform', platform, '-v', `${volume}:/artifacts`, image],
    { allowFailure: true }
  )
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  const failed = result.status !== 0
  if (expectFailure && failed) {
    assertExpectedNodeSandboxFailure(`${result.stdout}\n${result.stderr}`)
  }
  if (failed !== expectFailure) {
    fail(
      expectFailure
        ? 'AppImage CLI sandbox oracle unexpectedly passed'
        : `AppImage CLI sandbox oracle failed with status ${result.status}`
    )
  }
  console.log(expectFailure ? 'Observed expected contract failure.' : 'Contract validation passed.')
} finally {
  docker(['volume', 'rm', volume], { allowFailure: true })
  docker(['image', 'rm', image], { allowFailure: true })
}

function valueAfter(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? null : (args[index + 1] ?? null)
}

function assertExpectedNodeSandboxFailure(output) {
  for (const value of ['0', '1', '1-ish']) {
    const failureLine = output
      .split(/\r?\n/)
      .find((line) => line.includes(`FAIL node-capture value=${value}`))
    if (!failureLine || !failureLine.includes('bad option: --no-sandbox')) {
      fail(`Expected Node sandbox rejection was absent for ELECTRON_RUN_AS_NODE=${value}`)
    }
  }
  for (const mode of ['unset', 'empty']) {
    if (!output.includes(`PASS gui-capture mode=${mode}`)) {
      fail(`GUI fallback did not pass for ELECTRON_RUN_AS_NODE ${mode}`)
    }
  }
  // Three failed Node launches plus two GUI launches should produce five probes.
  if (!output.includes('FAIL unshare-probe expected=2 actual=5')) {
    fail('Expected five affected AppRun sandbox probes were not observed')
  }
}

function docker(dockerArgs, options = {}) {
  const result = spawnSync('docker', dockerArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0 && !options.allowFailure) {
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    fail(`docker ${dockerArgs[0]} failed with status ${result.status}`)
  }
  return result
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
  throw new Error(message)
}

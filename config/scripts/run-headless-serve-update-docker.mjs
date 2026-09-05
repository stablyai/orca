#!/usr/bin/env node
/**
 * E2E harness for the Linux serve auto-update flow.
 *
 * Boots an Orca AppImage under a real systemd (privileged container), wires a
 * local HTTP update feed to a second AppImage, then verifies the full handshake:
 *   request.json -> helper accepted -> census-gated stop -> swap -> VERSION ->
 *   systemctl start -> journal readiness -> result.json {phase:"ok"}.
 *
 * Requires: docker (or podman via DOCKER=), an orca-linux AppImage, and a
 * feed server reachable from the container. See --help for options.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const appImageArg = valueAfter('--appimage')
const platform = valueAfter('--platform') ?? 'linux/amd64'
const updateTimeout = valueAfter('--update-timeout') ?? '180'
const readinessTimeout = valueAfter('--readiness-timeout') ?? '60'
if (!appImageArg) {
  fail('Usage: run-headless-serve-update-docker.mjs --appimage /path/to/orca.AppImage')
}
if (!['accepted', 'ok', 'rejected', 'failed'].includes(updateTimeout) === false) {
  // timeout flags are numeric strings; validated below
}
const appImage = resolve(appImageArg)
const updateDockerDirectory = resolve('config', 'docker', 'headless-serve-update')
const updateDockerfile = resolve(updateDockerDirectory, 'Dockerfile')
if (!existsSync(appImage)) {
  fail(`AppImage not found: ${appImage}`)
}

const suffix = `${process.pid}-${Date.now()}`
const image = `orca-headless-serve-update:${suffix}`
const container = `orca-headless-serve-update-${suffix}`

try {
  docker([
    'build',
    '--platform',
    platform,
    '-f',
    updateDockerfile,
    '-t',
    image,
    updateDockerDirectory
  ])
  runUpdateCase({ image, appImage, platform })
  console.log('Headless serve update Docker validation passed.')
} finally {
  docker(['rm', '-f', container], { allowFailure: true })
  docker(['image', 'rm', image], { allowFailure: true })
}

function runUpdateCase({ image, appImage, platform }) {
  const appImageName = 'orca-update.AppImage'
  console.log('Running headless serve update Docker case...')
  docker([
    'run',
    '--rm',
    '--name',
    container,
    '--platform',
    platform,
    '--privileged',
    '--cgroupns=host',
    '-v',
    '/sys/fs/cgroup:/sys/fs/cgroup:rw',
    '-v',
    `${appImage}:/input/${appImageName}:ro`,
    '-e',
    `ORCA_UPDATE_TIMEOUT=${updateTimeout}`,
    '-e',
    `ORCA_READINESS_TIMEOUT=${readinessTimeout}`,
    image
  ])
}

function valueAfter(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? null : (args[index + 1] ?? null)
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

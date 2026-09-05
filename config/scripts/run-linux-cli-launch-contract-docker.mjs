#!/usr/bin/env node
// Exercise packaged CLI paths under the hostile Linux conditions from #11609/#12530/#13719/#14229.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const commandArgs = process.argv.slice(2)
const appImageArg = valueAfter('--appimage')
const appImage = appImageArg ? resolve(appImageArg) : null
const platform = valueAfter('--platform')
const dockerPlatformArgs = platform ? ['--platform', platform] : []

const suffix = `${process.pid}-${Date.now()}`
const artifactVolume = `orca-cli-contract-artifact-${suffix}`
const tagArchitecture = platform?.split('/')[1] ?? process.arch
const tag = `orca-cli-launch-contract:ubuntu-24.04-${tagArchitecture}-${suffix}`
const base = 'ubuntu@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90'
const containers = new Set()
let artifactVolumeCreated = false
const CASE_TIMEOUT_MS = 90_000
const BUILD_TIMEOUT_MS = 10 * 60_000
const STAGING_TIMEOUT_MS = 5 * 60_000
const DOCKER_TIMEOUT_MS = 2 * 60_000
const CLEANUP_TIMEOUT_MS = 30_000

// Exact statuses reject silent no-op launches as well as crashes.
const CASES = [
  {
    name: 'nofuse-userns-bundled-help',
    expectStatus: 0,
    expectOutput: 'Usage: orca <command>',
    why: 'The bundled launcher must run with no FUSE, no display, and userns restricted (#11609, #12530).'
  },
  {
    name: 'nofuse-userns-bundled-version',
    expectStatus: 0,
    expectOutput: /^\d+\.\d+\.\d+/m,
    why: 'A deployment must be able to read the installed version without a display (#13719).'
  },
  {
    name: 'nofuse-userns-bundled-status',
    // No runtime is running; the CLI must report that itself.
    expectStatus: 1,
    expectOutput: 'appRunning',
    why: 'A command that needs the runtime must report its absence, not abort.'
  },
  {
    name: 'nofuse-userns-bundled-skills',
    expectStatus: 0,
    // Why: the rendered help header, not a bare 'skills' — the case name contains that word.
    expectOutput: 'Usage: orca skills',
    why: 'skills is a pure-text command that must never need Chromium (#14229).'
  },
  {
    name: 'nofuse-userns-bundled-worktree',
    expectStatus: 1,
    expectOutput: "Orca is not running. Run 'orca open' first.",
    why: 'A runtime-dependent command must report the missing runtime, not abort.'
  },
  {
    name: 'nofuse-nosandbox-direct-binary-skills',
    expectStatus: 0,
    expectOutput: 'Usage: orca skills',
    why: 'A direct binary launch that reaches JavaScript must run the command, not boot a GUI (#14229).'
  },
  {
    name: 'nofuse-nosandbox-direct-binary-gui',
    // A missing display is an expected diagnosis, not a crash.
    expectStatus: 1,
    expectOutput: 'needs a usable display server',
    why: 'A desktop launch with no display must diagnose it instead of dying in uv_close (#13719).'
  },
  {
    name: 'stale-display-nosandbox-direct-binary-gui',
    expectStatus: 1,
    expectOutput: 'needs a usable display server',
    why: 'A stale DISPLAY value must diagnose the unreachable endpoint instead of dying in uv_close (#13719).'
  }
]

try {
  if (!appImage) {
    fail(
      'Usage: run-linux-cli-launch-contract-docker.mjs --appimage /path/to/orca-linux.AppImage [--platform linux/amd64|linux/arm64]'
    )
  }
  if (commandArgs.includes('--platform') && !platform) {
    fail('Missing value for --platform')
  }
  if (platform !== null && platform !== 'linux/amd64' && platform !== 'linux/arm64') {
    fail(`Unsupported --platform: ${platform}`)
  }
  if (!existsSync(appImage)) {
    fail(`AppImage not found: ${appImage}`)
  }
  docker(['volume', 'create', artifactVolume], { timeoutMs: DOCKER_TIMEOUT_MS })
  artifactVolumeCreated = true
  buildImage()
  stageArtifacts()
  runContract()
  console.log('\nLinux CLI launch contract passed.')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  for (const container of containers) {
    docker(['rm', '-f', container], { allowFailure: true, timeoutMs: CLEANUP_TIMEOUT_MS })
  }
  if (artifactVolumeCreated) {
    docker(['volume', 'rm', artifactVolume], {
      allowFailure: true,
      timeoutMs: CLEANUP_TIMEOUT_MS
    })
  }
  docker(['image', 'rm', tag], { allowFailure: true, timeoutMs: CLEANUP_TIMEOUT_MS })
}

function runContract() {
  const failures = []
  for (const testCase of CASES) {
    const output = runCase(testCase.name)
    const statusMatch = /^RESULT status=(\d+)/m.exec(output)
    if (!statusMatch) {
      failures.push(`${testCase.name}: ${firstLine(output)}\n    ${testCase.why}`)
      console.log(`  FAIL ${testCase.name} — ${firstLine(output)}`)
      continue
    }
    const status = Number(statusMatch[1])
    // Why: the harness echoes `RESULT status=N case=<name>`, so a case whose name contains the
    // expected substring would assert against the harness's own line instead of the CLI's output.
    const commandOutput = output
      .split('\n')
      .filter((line) => !/^(?:RESULT|CRASHED|PRECONDITION_FAILED) /.test(line))
      .join('\n')
    const matchesOutput =
      typeof testCase.expectOutput === 'string'
        ? commandOutput.includes(testCase.expectOutput)
        : testCase.expectOutput.test(commandOutput)
    if (status !== testCase.expectStatus || !matchesOutput) {
      failures.push(
        `${testCase.name}: expected status ${testCase.expectStatus} and ${testCase.expectOutput}, ` +
          `got status ${status}\n    ${testCase.why}`
      )
      console.log(`  FAIL ${testCase.name} — status ${status}`)
      continue
    }
    console.log(`  ok   ${testCase.name} (status ${status})`)
  }
  if (failures.length > 0) {
    fail(`Linux CLI launch contract failed:\n  - ${failures.join('\n  - ')}`)
  }
}

function runCase(caseName) {
  const container = `orca-cli-contract-${caseName}-${suffix}`
  containers.add(container)
  // FUSE and extra capabilities would invalidate the test conditions.
  return docker(
    [
      'run',
      ...dockerPlatformArgs,
      '--name',
      container,
      '--rm',
      '-v',
      `${artifactVolume}:/artifacts`,
      tag,
      caseName
    ],
    { allowFailure: true, capture: true, timeoutMs: CASE_TIMEOUT_MS }
  )
}

function buildImage() {
  console.log(`Building ${tag}…`)
  docker(
    [
      'build',
      ...dockerPlatformArgs,
      '--build-arg',
      `BASE_IMAGE=${base}`,
      '-f',
      'config/docker/cli-launch-contract/Dockerfile',
      '-t',
      tag,
      'config/docker/cli-launch-contract'
    ],
    { timeoutMs: BUILD_TIMEOUT_MS }
  )
}

// Extract unprivileged so chrome-sandbox is not root-owned setuid.
function stageArtifacts() {
  console.log('Staging the AppImage payload…')
  const container = `orca-cli-contract-stage-${suffix}`
  containers.add(container)
  docker(
    [
      'run',
      ...dockerPlatformArgs,
      '--name',
      container,
      '--rm',
      '-v',
      `${artifactVolume}:/artifacts`,
      '-v',
      `${appImage}:/input/orca-linux.AppImage:ro`,
      '--entrypoint',
      'bash',
      tag,
      '-lc',
      [
        'set -euo pipefail',
        'cp /input/orca-linux.AppImage /artifacts/orca-linux.AppImage',
        'chmod +x /artifacts/orca-linux.AppImage',
        'chown -R orca:orca /artifacts',
        // Use the AppImage runtime's no-FUSE extraction path.
        'cd /artifacts && runuser --user orca -- ./orca-linux.AppImage --appimage-extract >/dev/null',
        'test -x /artifacts/squashfs-root/resources/bin/orca-ide'
      ].join(' && ')
    ],
    { timeoutMs: STAGING_TIMEOUT_MS }
  )
}

function docker(args, options = {}) {
  try {
    const output = execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      timeout: options.timeoutMs ?? DOCKER_TIMEOUT_MS,
      killSignal: 'SIGTERM'
    })
    return output ?? ''
  } catch (error) {
    const timedOut = error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT'
    if (timedOut) {
      const message = `docker ${args.join(' ')} timed out after ${options.timeoutMs ?? DOCKER_TIMEOUT_MS}ms`
      if (!options.allowFailure) {
        fail(message)
      }
      return message
    }
    if (!options.allowFailure) {
      fail(
        `docker ${args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return `${error?.stdout ?? ''}${error?.stderr ?? ''}`
  }
}

function firstLine(value) {
  return (value ?? '').trim().split('\n')[0] || '(no output)'
}

function valueAfter(flag) {
  const index = commandArgs.indexOf(flag)
  return index === -1 ? null : (commandArgs[index + 1] ?? null)
}

function fail(message) {
  throw new Error(message)
}

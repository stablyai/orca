#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const TIMEOUT_MS = 120_000
const TERMINATION_GRACE_MS = 2_000
const EXPECTED_RESPONSE = 'ORCA_MIMOCODE_CONFIG_DIR_PROBE_OK'

function fail(message) {
  throw new Error(message)
}

export function runMimo(
  args,
  env = process.env,
  { command = 'mimo', timeoutMs = TIMEOUT_MS, graceMs = TERMINATION_GRACE_MS } = {}
) {
  return new Promise((resolveRun, rejectRun) => {
    const childEnv = { ...env }
    delete childEnv.MIMOCODE_HOME
    const child = spawn(command, args, {
      cwd: resolve(import.meta.dirname, '../..'),
      detached: process.platform !== 'win32',
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout = []
    const stderr = []
    let timedOut = false
    let settled = false
    let graceTimer
    const settle = (callback, value) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      callback(value)
    }
    const timeoutError = () => new Error(`mimo ${args[0]} timed out after ${timeoutMs}ms`)
    const killPosixGroup = (signal) => {
      if (!child.pid) {
        return
      }
      try {
        // detached gives this probe its own group, so descendants cannot keep stdio open.
        process.kill(-child.pid, signal)
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          child.kill(signal)
        }
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32' && child.pid) {
        const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore'
        })
        taskkill.on('error', () => child.kill())
        taskkill.on('close', (exitCode) => {
          if (exitCode !== 0) {
            child.kill()
          }
        })
      } else {
        killPosixGroup('SIGTERM')
      }
      graceTimer = setTimeout(() => {
        if (process.platform !== 'win32') {
          killPosixGroup('SIGKILL')
        }
        settle(rejectRun, timeoutError())
      }, graceMs)
    }, timeoutMs)

    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      if (timedOut) {
        settle(rejectRun, timeoutError())
      } else {
        settle(rejectRun, new Error(`could not start mimo ${args[0]}: ${error.message}`))
      }
    })
    child.on('close', (exitCode, signal) => {
      if (timedOut) {
        settle(rejectRun, timeoutError())
        return
      }
      settle(resolveRun, {
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      })
    })
  })
}

function assertExitZero(result, label) {
  if (result.exitCode !== 0) {
    fail(`${label} failed (exit=${String(result.exitCode)}, signal=${result.signal ?? 'none'})`)
  }
}

function parsePaths(stdout) {
  const paths = new Map()
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^(home|data|bin|log|cache|config|state)\s+(.+)$/)
    if (match) {
      paths.set(match[1], match[2].trim())
    }
  }
  for (const key of ['data', 'config', 'state']) {
    if (!paths.has(key)) {
      fail(`mimo debug paths did not report ${key}`)
    }
  }
  return paths
}

function stripAnsi(value) {
  const escape = String.fromCharCode(27)
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, 'g'), '')
}

function credentialPath(stdout) {
  const match = stripAnsi(stdout).match(/Credentials\s+([^\r\n]+)/)
  return match?.[1].trim()
}

function normalizedProviderStatus(stdout) {
  return stripAnsi(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line && !/^Credentials\s+/i.test(line))
}

function assertMarker(markerPath, invocation) {
  if (!existsSync(markerPath)) {
    fail(`overlay plugin did not write its marker during ${invocation}`)
  }
  if (readFileSync(markerPath, 'utf8') !== 'loaded\n') {
    fail(`overlay plugin wrote an unexpected marker during ${invocation}`)
  }
}

function assertOverlayHasNoCanonicalState(overlayDir) {
  const allowed = new Set([
    '.gitignore',
    'marker',
    'node_modules',
    'package-lock.json',
    'package.json',
    'plugins'
  ])
  const unexpected = readdirSync(overlayDir).filter((entry) => !allowed.has(entry))
  if (unexpected.length > 0) {
    fail(`overlay received unexpected state entries: ${unexpected.join(', ')}`)
  }

  const forbiddenRootNames = new Set([
    'auth.json',
    'data',
    'session',
    'sessions',
    'state',
    'storage'
  ])
  for (const entry of readdirSync(overlayDir)) {
    if (forbiddenRootNames.has(entry)) {
      fail(`overlay received canonical state path: ${entry}`)
    }
  }

  const pending = [overlayDir]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'auth.json') {
        fail('overlay received an auth.json file')
      }
      if (entry.isDirectory()) {
        pending.push(join(directory, entry.name))
      }
    }
  }
}

async function main() {
  const scratchDir = mkdtempSync(join(tmpdir(), 'orca-mimocode-config-dir-'))
  let failure
  let cleanupFailure
  try {
    const overlayDir = join(scratchDir, 'config')
    const pluginsDir = join(overlayDir, 'plugins')
    const markerPath = join(overlayDir, 'marker')
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(
      join(pluginsDir, 'orca-probe.js'),
      [
        "import { writeFile } from 'node:fs/promises'",
        '',
        'export const OrcaProbePlugin = async () => {',
        "  await writeFile(process.env.ORCA_MIMO_PROBE_MARKER, 'loaded\\n')",
        '  return {}',
        '}',
        ''
      ].join('\n')
    )

    const baselineEnv = { ...process.env }
    delete baselineEnv.MIMOCODE_CONFIG_DIR
    delete baselineEnv.ORCA_MIMO_PROBE_MARKER
    const overlayEnv = {
      ...baselineEnv,
      MIMOCODE_CONFIG_DIR: overlayDir,
      ORCA_MIMO_PROBE_MARKER: markerPath
    }

    const versionResult = await runMimo(['--version'], baselineEnv)
    assertExitZero(versionResult, 'version query')
    const version = versionResult.stdout.trim()
    if (version !== '0.1.6') {
      fail(`expected MiMoCode 0.1.6, found ${version || 'unknown'}`)
    }

    const baselinePathsResult = await runMimo(['debug', 'paths'], baselineEnv)
    assertExitZero(baselinePathsResult, 'baseline path query')
    const baselinePaths = parsePaths(baselinePathsResult.stdout)

    rmSync(markerPath, { force: true })
    const overlayPathsResult = await runMimo(['debug', 'paths'], overlayEnv)
    assertExitZero(overlayPathsResult, 'overlay path query')
    const overlayPaths = parsePaths(overlayPathsResult.stdout)
    for (const key of ['data', 'config', 'state']) {
      if (baselinePaths.get(key) !== overlayPaths.get(key)) {
        fail(`MIMOCODE_CONFIG_DIR redirected canonical ${key}`)
      }
    }

    const baselineProvidersResult = await runMimo(['providers', 'list'], baselineEnv)
    assertExitZero(baselineProvidersResult, 'baseline provider query')
    rmSync(markerPath, { force: true })
    const overlayProvidersResult = await runMimo(['providers', 'list'], overlayEnv)
    assertExitZero(overlayProvidersResult, 'overlay provider query')
    const baselineProviderStatus = normalizedProviderStatus(baselineProvidersResult.stdout)
    const overlayProviderStatus = normalizedProviderStatus(overlayProvidersResult.stdout)
    if (JSON.stringify(baselineProviderStatus) !== JSON.stringify(overlayProviderStatus)) {
      fail('MIMOCODE_CONFIG_DIR changed provider status')
    }
    const reportedCredentialPath = credentialPath(overlayProvidersResult.stdout)
    const expectedCredentialPath = join(baselinePaths.get('data'), 'auth.json')
    if (!reportedCredentialPath) {
      fail('provider query did not report a credential path')
    }
    const expandedCredentialPath = reportedCredentialPath.startsWith('~/')
      ? join(process.env.HOME ?? '', reportedCredentialPath.slice(2))
      : reportedCredentialPath
    if (resolve(expandedCredentialPath) !== resolve(expectedCredentialPath)) {
      fail('MIMOCODE_CONFIG_DIR redirected the credential path')
    }

    rmSync(markerPath, { force: true })
    const modelResult = await runMimo(
      [
        'run',
        '--format',
        'json',
        `Reply with exactly ${EXPECTED_RESPONSE}. Do not use tools or modify files.`
      ],
      overlayEnv
    )
    assertExitZero(modelResult, 'side-effect-free model request')
    assertMarker(markerPath, 'model request')
    if (!modelResult.stdout.includes(EXPECTED_RESPONSE)) {
      fail('model request succeeded but did not return the expected response')
    }

    assertOverlayHasNoCanonicalState(overlayDir)

    process.stdout.write('DONE\n')
    process.stdout.write(`mimo_version=${version}\n`)
    process.stdout.write(`overlay=${basename(overlayDir)} (temporary)\n`)
    process.stdout.write(`plugin_marker=success\n`)
    process.stdout.write(`canonical_paths_unchanged=data,config,state\n`)
    process.stdout.write(`canonical_credential_path=unchanged\n`)
    process.stdout.write(`provider_query=success\n`)
    process.stdout.write(`model_request=success\n`)
    process.stdout.write(`overlay_state_side_effects=none\n`)
  } catch (error) {
    failure = error
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true })
    } catch (cleanupError) {
      cleanupFailure = cleanupError
    }
  }
  if (failure !== undefined) {
    throw failure
  }
  if (cleanupFailure !== undefined) {
    throw cleanupFailure
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`BLOCKED: ${message}\n`)
    process.exitCode = 1
  })
}

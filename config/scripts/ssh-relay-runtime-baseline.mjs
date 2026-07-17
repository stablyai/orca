import { execFile } from 'node:child_process'
import { readdir, realpath } from 'node:fs/promises'
import { release } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 30_000
const COMMAND_OUTPUT_BYTES = 1024 * 1024
const MAX_RUNTIME_ENTRIES = 100
const MAX_RUNTIME_DEPTH = 8

const BASELINES = Object.freeze({
  'linux-x64-glibc': {
    platform: 'linux',
    architecture: 'x64',
    glibc: sshRelayRuntimeCompatibility['linux-x64-glibc'].libc.minimumVersion,
    libstdcxx: sshRelayRuntimeCompatibility['linux-x64-glibc'].libc.minimumLibstdcxxVersion,
    kernel: sshRelayRuntimeCompatibility['linux-x64-glibc'].minimumKernelVersion
  },
  'linux-arm64-glibc': {
    platform: 'linux',
    architecture: 'arm64',
    glibc: sshRelayRuntimeCompatibility['linux-arm64-glibc'].libc.minimumVersion,
    libstdcxx: sshRelayRuntimeCompatibility['linux-arm64-glibc'].libc.minimumLibstdcxxVersion,
    kernel: sshRelayRuntimeCompatibility['linux-arm64-glibc'].minimumKernelVersion
  },
  'darwin-x64': {
    platform: 'darwin',
    architecture: 'x64',
    osVersion: sshRelayRuntimeCompatibility['darwin-x64'].minimumVersion
  },
  'darwin-arm64': {
    platform: 'darwin',
    architecture: 'arm64',
    osVersion: sshRelayRuntimeCompatibility['darwin-arm64'].minimumVersion
  },
  'win32-x64': {
    platform: 'win32',
    architecture: 'x64',
    // Why: the reviewed x64 floor permits either Windows 10 22H2 or Server 2022.
    osBuilds: [sshRelayRuntimeCompatibility['win32-x64'].minimumBuild, 20348]
  },
  'win32-arm64': {
    platform: 'win32',
    architecture: 'arm64',
    osBuilds: [sshRelayRuntimeCompatibility['win32-arm64'].minimumBuild]
  }
})

function majorMinor(value) {
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(value ?? '')
  return match ? `${Number(match[1])}.${Number(match[2])}` : null
}

function windowsBuild(value) {
  const match = /^\d+\.\d+\.(\d+)(?:\.|$)/.exec(value ?? '')
  return match ? Number(match[1]) : null
}

export function evaluateSshRelayRuntimeBaseline({
  tuple,
  scope = 'full',
  platform,
  architecture,
  osVersion,
  kernelVersion,
  glibcVersion,
  libstdcxxVersion
}) {
  const contract = BASELINES[tuple]
  if (!contract) {
    throw new Error(`Unknown SSH relay runtime baseline tuple: ${tuple}`)
  }
  if (scope !== 'full' && !(scope === 'linux-userland' && contract.platform === 'linux')) {
    throw new Error(`Unsupported SSH relay runtime baseline scope: ${scope}`)
  }
  const checks = {
    platform: platform === contract.platform,
    architecture: architecture === contract.architecture
  }
  // Why: execution on a newer host does not prove the declared oldest floor can run these bytes.
  if (contract.platform === 'linux') {
    checks.glibc = majorMinor(glibcVersion) === contract.glibc
    checks.libstdcxx = libstdcxxVersion === contract.libstdcxx
    checks.kernel = majorMinor(kernelVersion) === contract.kernel
  } else if (contract.platform === 'darwin') {
    checks.osVersion = majorMinor(osVersion) === contract.osVersion
  } else {
    checks.osBuild = contract.osBuilds.includes(windowsBuild(osVersion))
  }
  const requiredChecks =
    scope === 'linux-userland'
      ? ['platform', 'architecture', 'glibc', 'libstdcxx']
      : Object.keys(checks)
  const residualGaps = Object.keys(checks).filter((name) => !requiredChecks.includes(name))
  return {
    tuple,
    scope,
    qualified: requiredChecks.every((name) => checks[name]),
    residualGaps,
    contract,
    observed: {
      platform,
      architecture,
      osVersion: osVersion ?? null,
      kernelVersion: kernelVersion ?? null,
      glibcVersion: glibcVersion ?? null,
      libstdcxxVersion: libstdcxxVersion ?? null
    },
    checks
  }
}

export function parseSshRelayRuntimeLddLibstdcxxPaths(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > COMMAND_OUTPUT_BYTES) {
    throw new Error('Runtime baseline ldd output is missing or oversized')
  }
  if (/=>\s+not found|version\s+[`'][^`']+['`]\s+not found/i.test(output)) {
    // Why: an exact userland version is irrelevant when the staged native module cannot load.
    throw new Error('Runtime baseline ldd output contains an unresolved native dependency')
  }
  return output
    .split(/\r?\n/)
    .map((line) => /libstdc\+\+\.so\.6\s+=>\s+(\/\S+)/.exec(line)?.[1])
    .filter(Boolean)
}

export function parseSshRelayRuntimeLibstdcxxVersion(libraryPaths) {
  if (!Array.isArray(libraryPaths) || libraryPaths.length === 0) {
    throw new Error('Runtime baseline did not resolve a libstdc++ ABI library')
  }
  const versions = new Set(
    libraryPaths.map((path) => /^libstdc\+\+\.so\.(\d+\.\d+\.\d+)$/.exec(basename(path))?.[1])
  )
  if (versions.has(undefined) || versions.size !== 1) {
    throw new Error('Runtime baseline did not resolve one bounded libstdc++ ABI library')
  }
  return versions.values().next().value
}

async function runtimeNativeModules(runtimeDirectory) {
  const modules = []
  let entries = 0
  async function visit(directory, depth) {
    if (depth > MAX_RUNTIME_DEPTH) {
      throw new Error('Runtime baseline tree exceeds the depth bound')
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1
      if (entries > MAX_RUNTIME_ENTRIES) {
        throw new Error('Runtime baseline tree exceeds the entry bound')
      }
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.node')) {
        modules.push(path)
      } else if (!entry.isFile()) {
        throw new Error('Runtime baseline tree contains a special entry')
      }
    }
  }
  await visit(runtimeDirectory, 0)
  if (modules.length === 0) {
    throw new Error('Runtime baseline tree contains no native modules')
  }
  return modules
}

async function linuxLibstdcxxVersion(runtimeDirectory) {
  const libraryPaths = new Set()
  for (const modulePath of await runtimeNativeModules(runtimeDirectory)) {
    const { stdout, stderr } = await execFileAsync('ldd', [modulePath], {
      encoding: 'utf8',
      maxBuffer: COMMAND_OUTPUT_BYTES,
      timeout: COMMAND_TIMEOUT_MS
    })
    for (const path of parseSshRelayRuntimeLddLibstdcxxPaths(`${stderr}\n${stdout}`)) {
      libraryPaths.add(await realpath(path))
    }
  }
  return parseSshRelayRuntimeLibstdcxxVersion([...libraryPaths])
}

async function collectObservedBaseline({ tuple, runtimeDirectory }) {
  const contract = BASELINES[tuple]
  if (!contract) {
    throw new Error(`Unknown SSH relay runtime baseline tuple: ${tuple}`)
  }
  const observed = {
    platform: process.platform,
    architecture: process.arch,
    kernelVersion: release()
  }
  if (contract.platform === 'linux') {
    if (!runtimeDirectory) {
      throw new Error('--runtime-directory is required for a Linux baseline')
    }
    observed.glibcVersion = process.report.getReport().header.glibcVersionRuntime
    observed.libstdcxxVersion = await linuxLibstdcxxVersion(runtimeDirectory)
  } else if (contract.platform === 'darwin') {
    const { stdout } = await execFileAsync('sw_vers', ['-productVersion'], {
      encoding: 'utf8',
      maxBuffer: COMMAND_OUTPUT_BYTES,
      timeout: COMMAND_TIMEOUT_MS
    })
    observed.osVersion = stdout.trim()
  } else {
    observed.osVersion = release()
  }
  return observed
}

function parseArguments(argv) {
  const result = { scope: 'full' }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`)
    }
    if (flag === '--tuple') {
      result.tuple = value
    } else if (flag === '--scope') {
      result.scope = value
    } else if (flag === '--runtime-directory') {
      result.runtimeDirectory = resolve(value)
    } else {
      throw new Error(`Unknown argument: ${flag}`)
    }
  }
  if (!result.tuple) {
    throw new Error('--tuple is required')
  }
  return result
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const result = evaluateSshRelayRuntimeBaseline({
    ...options,
    ...(await collectObservedBaseline(options))
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.qualified) {
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    process.stderr.write(`SSH relay runtime baseline verification failed: ${error.message}\n`)
    process.exitCode = 1
  })
}

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const SCHEMA_VERSION = 1
const CAPABILITY_VERSION = 1

export function createUnobservedWindowsJobObjectEvidence(platform = process.platform) {
  return {
    schema_version: SCHEMA_VERSION,
    task_id: 'ORC-07W',
    status: 'unobserved',
    implementation_host: { platform, arch: process.arch },
    capability: {
      version: CAPABILITY_VERSION,
      windows_job_object: false,
      exact_auto_release: false
    },
    reason: 'Native Windows Job Object proof is unavailable on this implementation host.',
    observed_at: null,
    probe: null
  }
}

export function validateWindowsJobObjectEvidence(value, platform = process.platform) {
  if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION || value.task_id !== 'ORC-07W') {
    throw new Error('Invalid Windows Job Object evidence identity')
  }
  if (!isRecord(value.capability) || value.capability.version !== CAPABILITY_VERSION) {
    throw new Error('Invalid Windows Job Object capability')
  }
  if (platform !== 'win32') {
    if (
      value.status !== 'unobserved' ||
      value.capability.windows_job_object !== false ||
      value.capability.exact_auto_release !== false ||
      value.probe !== null
    ) {
      throw new Error('Non-Windows evidence must remain unobserved and capability-disabled')
    }
    return value
  }
  if (
    value.status !== 'observed' ||
    value.capability.windows_job_object !== true ||
    value.capability.exact_auto_release !== true ||
    !isRecord(value.probe) ||
    value.probe.parent_and_grandchildren_terminated !== true ||
    value.probe.restart_job_isolated !== true
  ) {
    throw new Error('Windows evidence does not prove exact Job Object containment')
  }
  return value
}

export async function runWindowsPtyJobObjectProbe(platform = process.platform) {
  if (platform !== 'win32') {
    return createUnobservedWindowsJobObjectEvidence(platform)
  }

  const { spawn } = await import('node-pty')
  const probeDir = await mkdtemp(resolve(tmpdir(), 'orca-windows-job-object-'))
  const childScript = resolve(probeDir, 'process-tree.cjs')
  await writeFile(childScript, processTreeScript, 'utf8')
  try {
    const first = await runTree(spawn, childScript)
    const second = await runTree(spawn, childScript)
    const firstPids = Object.values(first.roles)
    const secondPids = Object.values(second.roles)
    const isolated = firstPids.every((pid) => !secondPids.includes(pid))
    return {
      schema_version: SCHEMA_VERSION,
      task_id: 'ORC-07W',
      status: 'observed',
      implementation_host: { platform, arch: process.arch },
      capability: {
        version: CAPABILITY_VERSION,
        windows_job_object: true,
        exact_auto_release: true
      },
      observed_at: new Date().toISOString(),
      probe: {
        parent_and_grandchildren_terminated: first.allAbsent,
        restart_job_isolated: isolated && second.allAbsent,
        first_tree: first.roles,
        second_tree: second.roles,
        receipt_sha256: createHash('sha256').update(JSON.stringify(first.receipt)).digest('hex')
      }
    }
  } finally {
    await rm(probeDir, { recursive: true, force: true })
  }
}

export async function writeWindowsPtyJobObjectEvidence(evidencePath, platform = process.platform) {
  const evidence = validateWindowsJobObjectEvidence(
    await runWindowsPtyJobObjectProbe(platform),
    platform
  )
  await mkdir(dirname(evidencePath), { recursive: true })
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  return evidence
}

async function runTree(spawn, childScript) {
  const term = spawn(process.execPath, [childScript, 'parent'], {
    cols: 80,
    rows: 24,
    cwd: dirname(childScript),
    env: process.env,
    useConpty: true
  })
  if (term.windowsJobObjectAssigned !== true) {
    term.kill()
    throw new Error('node-pty did not assign the ConPTY root to a Job Object')
  }
  let roles
  try {
    roles = await collectRoles(term)
  } catch (error) {
    term.kill()
    throw error
  }
  term.kill()
  const receipt = term.windowsJobObjectStopReceipt
  if (!isExactReceipt(receipt, roles)) {
    throw new Error('Job Object returned no exact stop receipt')
  }
  const allAbsent = await waitForAllAbsent(Object.values(roles))
  if (!allAbsent) {
    throw new Error('Job Object descendants remained live after termination')
  }
  return { roles, receipt, allAbsent }
}

function collectRoles(term) {
  return new Promise((resolveRoles, reject) => {
    const roles = {}
    let output = ''
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for PTY descendants')),
      10_000
    )
    const disposable = term.onData((chunk) => {
      output += chunk
      for (const match of output.matchAll(/ORC07W_PID:(parent|child|grandchild):(\d+)/g)) {
        roles[match[1]] = Number(match[2])
      }
      if (Object.keys(roles).length === 3) {
        clearTimeout(timeout)
        disposable.dispose()
        resolveRoles(roles)
      }
    })
  })
}

function isExactReceipt(value, roles) {
  if (!isRecord(value) || value.version !== CAPABILITY_VERSION) {
    return false
  }
  if (
    value.assigned !== true ||
    value.processTreeVerified !== true ||
    !Array.isArray(value.identities)
  ) {
    return false
  }
  const identities = new Set(value.identities.map((identity) => identity?.pid))
  return Object.values(roles).every((pid) => identities.has(pid))
}

async function waitForAllAbsent(pids) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (pids.every(isAbsent)) {
      return true
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  return false
}

function isAbsent(pid) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const processTreeScript = String.raw`
const { spawn } = require('node:child_process')
const role = process.argv[2]
console.log('ORC07W_PID:' + role + ':' + process.pid)
if (role === 'parent') spawn(process.execPath, [__filename, 'child'], { stdio: 'inherit' })
if (role === 'child') spawn(process.execPath, [__filename, 'grandchild'], { stdio: 'inherit' })
setInterval(() => {}, 1000)
`

function parseEvidencePath(argv) {
  const index = argv.indexOf('--evidence')
  if (index === -1 || !argv[index + 1]) {
    throw new Error('Usage: --evidence <path>')
  }
  return resolve(argv[index + 1])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeWindowsPtyJobObjectEvidence(parseEvidencePath(process.argv.slice(2))).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

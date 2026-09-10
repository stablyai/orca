import { createHash } from 'node:crypto'
import { spawn as spawnProcess } from 'node:child_process'
import { isAbsolute, resolve, win32 } from 'node:path'
import process from 'node:process'
import { TextDecoder } from 'node:util'

export const PROBE_SCHEMA_VERSION = 1
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024
export const DEFAULT_MAX_CAPSULE_BYTES = 8 * 1024
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const TERMINATION_GRACE_MS = 50

const FORBIDDEN_CAPSULE_KEYS = new Set([
  'accessibility_tree',
  'authorization',
  'authorization_data',
  'cookie',
  'cookies',
  'dom',
  'frames',
  'html',
  'live_frame',
  'prompt',
  'screenshot',
  'screenshot_bytes',
  'storage',
  'transcript'
])

export class ProbeContractError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ProbeContractError'
    this.code = code
    this.details = details
  }
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function containsKey(value, key) {
  if (Array.isArray(value)) {
    return value.some((entry) => containsKey(entry, key))
  }
  if (!isRecord(value)) {
    return false
  }
  return Object.entries(value).some(
    ([entryKey, entryValue]) => entryKey === key || containsKey(entryValue, key)
  )
}

export function requireRecord(value, message) {
  if (!isRecord(value)) {
    throw new ProbeContractError('invalid_contract', message)
  }
  return value
}

export function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProbeContractError('invalid_contract', `${field} must be a non-empty string`)
  }
  return value
}

export function requireInteger(value, field, { min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min) {
    throw new ProbeContractError('invalid_contract', `${field} must be an integer >= ${min}`)
  }
  return value
}

export function assertAbsolutePath(value, field) {
  requireString(value, field)
  if (!isAbsolute(value) && !win32.isAbsolute(value)) {
    throw new ProbeContractError('invalid_target_path', `${field} must be an absolute path`)
  }
  return isAbsolute(value) ? resolve(value) : win32.normalize(value)
}

export function getRepositoryTarget(targets, key, aliases) {
  for (const alias of aliases) {
    if (isRecord(targets[alias])) {
      return targets[alias]
    }
  }
  if (Array.isArray(targets.repositories)) {
    const match = targets.repositories.find(
      (repository) => isRecord(repository) && (repository.key === key || repository.name === key)
    )
    if (match) {
      return match
    }
  }
  throw new ProbeContractError('missing_target', `Explicit ${key} repository target is required`)
}

export function normalizeRepositoryTarget(key, value) {
  requireRecord(value, `${key} repository target must be an object`)
  const root = assertAbsolutePath(value.root ?? value.path, `${key}.root`)
  const revision = requireString(value.revision ?? value.commit, `${key}.revision`)
  const repositoryId = requireString(
    value.repository_id ?? value.repositoryId ?? value.identity,
    `${key}.repository_id`
  )
  return { key, root, revision, repository_id: repositoryId }
}

function createOutputStreamState() {
  return { decoder: new TextDecoder('utf-8', { fatal: true }), value: '' }
}

function terminateChild(child, platform, killProcessGroup) {
  if (!child) {
    return
  }
  if (platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      killProcessGroup(child.pid, 'SIGTERM')
      return
    } catch {
      // Fall through to the child-owned kill path.
    }
  }
  if (typeof child.kill === 'function') {
    child.kill(platform === 'win32' ? undefined : 'SIGTERM')
  }
}

function forceTerminateChild(child, platform, killProcessGroup) {
  if (!child) {
    return
  }
  if (platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      killProcessGroup(child.pid, 'SIGKILL')
      return
    } catch {
      // Fall through to the child-owned kill path.
    }
  }
  if (typeof child.kill === 'function') {
    child.kill(platform === 'win32' ? undefined : 'SIGKILL')
  }
}

export function runBoundedCommand({
  command,
  args = [],
  cwd,
  env = process.env,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  platform = process.platform,
  spawnImpl = spawnProcess,
  killProcessGroup = (pid, signal) => process.kill(-pid, signal),
  signal
}) {
  requireString(command, 'command')
  requireInteger(timeoutMs, 'timeoutMs', { min: 1 })
  requireInteger(maxOutputBytes, 'maxOutputBytes', { min: 1 })
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new ProbeContractError('invalid_command', 'args must be string arguments')
  }

  return new Promise((resolveResult) => {
    let child
    let stdout = ''
    let stderr = ''
    let outputOverflow = false
    let outputBytes = 0
    let timedOut = false
    let receivedSignal = null
    let spawnError = null
    let finished = false
    let timeout
    let terminationTimer
    let removeAbortListener = () => {}
    const outputStreams = {
      stdout: createOutputStreamState(),
      stderr: createOutputStreamState()
    }

    const flushOutputStreams = () => {
      for (const stream of Object.values(outputStreams)) {
        try {
          stream.value += stream.decoder.decode()
        } catch {
          // Drop an incomplete trailing code point rather than emitting U+FFFD.
        }
      }
      stdout = outputStreams.stdout.value
      stderr = outputStreams.stderr.value
    }

    const finish = (status, exitSignal) => {
      if (finished) {
        return
      }
      flushOutputStreams()
      finished = true
      clearTimeout(timeout)
      clearTimeout(terminationTimer)
      removeAbortListener()
      resolveResult({
        status: Number.isInteger(status) ? status : null,
        signal: receivedSignal ?? exitSignal ?? null,
        stdout,
        stderr,
        output_truncated: outputOverflow,
        timed_out: timedOut,
        error_code: spawnError
          ? 'spawn_error'
          : outputOverflow
            ? 'output_limit'
            : timedOut
              ? 'timeout'
              : receivedSignal
                ? 'aborted'
                : null,
        error_message: spawnError ? String(spawnError.message ?? spawnError) : null
      })
    }

    const stopForBound = () => {
      terminateChild(child, platform, killProcessGroup)
      if (!terminationTimer && !finished) {
        terminationTimer = setTimeout(() => {
          if (finished) {
            return
          }
          forceTerminateChild(child, platform, killProcessGroup)
          finish(null, null)
        }, TERMINATION_GRACE_MS)
      }
    }

    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        detached: platform !== 'win32',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      spawnError = error
      finish(null, null)
      return
    }

    const collect = (stream, state) => {
      if (!stream || typeof stream.on !== 'function') {
        return
      }
      stream.on('data', (chunk) => {
        const encoded = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
        const remaining = Math.max(0, maxOutputBytes - outputBytes)
        const accepted = encoded.subarray(0, remaining)
        state.value += state.decoder.decode(accepted, { stream: true })
        outputBytes += accepted.byteLength
        stdout = outputStreams.stdout.value
        stderr = outputStreams.stderr.value
        if (accepted.byteLength < encoded.byteLength && !outputOverflow) {
          outputOverflow = true
          stopForBound()
        }
      })
    }
    collect(child.stdout, outputStreams.stdout)
    collect(child.stderr, outputStreams.stderr)

    if (typeof child.once === 'function') {
      child.once('error', (error) => {
        spawnError = error
        if (!child.pid) {
          finish(null, null)
        }
      })
      child.once('close', finish)
    } else {
      finish(null, null)
      return
    }
    if (signal) {
      const abort = () => {
        receivedSignal = typeof signal.reason === 'string' ? signal.reason : 'SIGTERM'
        stopForBound()
      }
      if (signal.aborted) {
        abort()
      } else {
        signal.addEventListener('abort', abort, { once: true })
        removeAbortListener = () => signal.removeEventListener('abort', abort)
      }
    }
    if (finished) {
      return
    }
    if (!signal?.aborted) {
      timeout = setTimeout(() => {
        timedOut = true
        stopForBound()
      }, timeoutMs)
    }
  })
}

function walkCapsule(value, path = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkCapsule(entry, [...path, String(index)]))
    return
  }
  if (!isRecord(value)) {
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CAPSULE_KEYS.has(key.toLowerCase())) {
      throw new ProbeContractError(
        'capsule_privacy_violation',
        `Capsule contains forbidden field ${key}`,
        { path: [...path, key].join('.') }
      )
    }
    walkCapsule(child, [...path, key])
  }
}

export function createImmutableCapsule({
  task,
  workspace_scope,
  evidence_refs = [],
  unresolved_findings = [],
  launch_profile,
  maxBytes = DEFAULT_MAX_CAPSULE_BYTES
}) {
  if (!Array.isArray(evidence_refs) || !Array.isArray(unresolved_findings)) {
    throw new ProbeContractError(
      'invalid_capsule',
      'Capsule evidence_refs and unresolved_findings must be arrays'
    )
  }
  const capsule = {
    schema_version: PROBE_SCHEMA_VERSION,
    task: requireRecord(task, 'Capsule task contract is required'),
    workspace_scope: requireRecord(workspace_scope, 'Capsule workspace scope is required'),
    evidence_refs: [...evidence_refs],
    unresolved_findings: [...unresolved_findings],
    launch_profile: requireRecord(launch_profile, 'Capsule launch profile is required')
  }
  walkCapsule(capsule)
  const serialized = JSON.stringify(capsule)
  const byteCount = Buffer.byteLength(serialized, 'utf8')
  if (byteCount > maxBytes) {
    throw new ProbeContractError('capsule_too_large', 'Capsule exceeds the bounded size', {
      byte_count: byteCount,
      max_bytes: maxBytes
    })
  }
  return Object.freeze({
    ...capsule,
    byte_count: byteCount,
    digest: `sha256:${createHash('sha256').update(serialized).digest('hex')}`
  })
}

export function createOwnedResourceScope() {
  const processes = []
  const browsers = []
  const childWorktrees = []
  let cleaned = false
  const rejectUserResource = (resource) => {
    if (resource?.owner !== 'harness' || resource.user_owned === true) {
      throw new ProbeContractError(
        'ownership_violation',
        'Probe can track only Harness-owned resources'
      )
    }
  }
  return {
    trackProcess(resource) {
      rejectUserResource(resource)
      processes.push(resource)
      return resource
    },
    trackBrowser(resource) {
      rejectUserResource(resource)
      browsers.push(resource)
      return resource
    },
    trackChildWorktree(resource) {
      rejectUserResource(resource)
      childWorktrees.push(resource)
      return resource
    },
    async cleanup() {
      if (cleaned) {
        return { processes: [], browsers: [], child_worktrees: [], repeated: true }
      }
      const processReceipts = []
      const failures = []
      for (const resource of processes.toReversed()) {
        try {
          const receipt = await resource.stop()
          if (!['exited', 'released'].includes(receipt?.verdict)) {
            throw new ProbeContractError(
              'cleanup_unverified',
              'Owned process cleanup was not verified'
            )
          }
          processReceipts.push(receipt)
        } catch (error) {
          failures.push({ kind: 'process', error: String(error) })
        }
      }
      const browserReceipts = []
      for (const resource of browsers.toReversed()) {
        try {
          const receipt = await resource.release()
          if (receipt?.closed !== true) {
            throw new ProbeContractError(
              'cleanup_unverified',
              'Owned Browser cleanup was not verified'
            )
          }
          browserReceipts.push(receipt)
        } catch (error) {
          failures.push({ kind: 'browser', error: String(error) })
        }
      }
      const childReceipts = []
      for (const resource of childWorktrees.toReversed()) {
        try {
          const receipt = await resource.retire()
          if (receipt?.retired !== true) {
            throw new ProbeContractError(
              'cleanup_unverified',
              'Child worktree retirement was not verified'
            )
          }
          childReceipts.push(receipt)
        } catch (error) {
          failures.push({ kind: 'child_worktree', error: String(error) })
        }
      }
      if (failures.length > 0) {
        throw new ProbeContractError(
          'cleanup_partial_failure',
          'Owned resource cleanup was incomplete',
          { failures }
        )
      }
      cleaned = true
      return {
        processes: processReceipts,
        browsers: browserReceipts,
        child_worktrees: childReceipts,
        repeated: false
      }
    }
  }
}

export function installProbeSignalHandlers(abortController, signalTarget = process) {
  const onSigint = () => abortController.abort('SIGINT')
  const onSigterm = () => abortController.abort('SIGTERM')
  signalTarget.once('SIGINT', onSigint)
  signalTarget.once('SIGTERM', onSigterm)
  return () => {
    signalTarget.removeListener('SIGINT', onSigint)
    signalTarget.removeListener('SIGTERM', onSigterm)
  }
}

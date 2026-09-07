import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const PROCESS_EXIT_TIMEOUT_MS = 2_000
const PROCESS_POLL_MS = 25
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

const processIdentityOperations = {
  executePs: execFileSync,
  signalProcess: process.kill.bind(process)
}

export function processIdentity(pid, operations = processIdentityOperations) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null
  }
  try {
    const output = operations
      .executePs('ps', ['-p', String(pid), '-o', 'pid=,pgid=,command='], {
        encoding: 'utf8'
      })
      .trim()
    const match = output.match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) {
      throw new Error(`Could not parse process identity for ${pid}`)
    }
    return { pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }
  } catch (error) {
    try {
      operations.signalProcess(pid, 0)
    } catch (lookupError) {
      if (lookupError?.code === 'ESRCH') {
        return null
      }
    }
    throw error
  }
}

function matchingDetachedProcesses(identities, expectedCommandFragments) {
  return identities.filter(
    (identity) =>
      identity.pgid === identity.pid &&
      expectedCommandFragments.every((fragment) => identity.command.includes(fragment))
  )
}

const matchingProcessOperations = {
  processIdentities,
  signalProcessIdentity,
  waitForIdentityExit
}

export function killProcessMatchingCommand(
  expectedCommandFragments,
  operations = matchingProcessOperations
) {
  const matches = matchingDetachedProcesses(
    operations.processIdentities(),
    expectedCommandFragments
  )
  if (matches.length === 0) {
    return false
  }
  const errors = []
  for (const match of matches) {
    try {
      if (operations.signalProcessIdentity(match, expectedCommandFragments[0], 'SIGKILL')) {
        operations.waitForIdentityExit(match)
      }
    } catch (error) {
      errors.push(error)
    }
  }
  try {
    const remaining = matchingDetachedProcesses(
      operations.processIdentities(),
      expectedCommandFragments
    )
    if (remaining.length > 0) {
      errors.push(
        new Error(
          `Benchmark helper cleanup left matching processes: ${remaining
            .map((identity) => identity.pid)
            .join(', ')}`
        )
      )
    }
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Benchmark exact-command cleanup failed')
  }
  return true
}

function sleepSync(milliseconds) {
  Atomics.wait(sleepBuffer, 0, 0, milliseconds)
}

function validateDetachedIdentity(identity, expectedCommandFragment) {
  if (
    !Number.isInteger(identity?.pid) ||
    identity.pid <= 0 ||
    identity.pgid !== identity.pid ||
    typeof identity.command !== 'string' ||
    !identity.command.includes(expectedCommandFragment)
  ) {
    throw new Error('Recorded benchmark helper identity is invalid')
  }
}

function sameIdentity(left, right) {
  return left?.pid === right?.pid && left?.pgid === right?.pgid && left?.command === right?.command
}

function processIdentities(includeEnvironment = false) {
  const args = includeEnvironment
    ? ['eww', '-axo', 'pid=,pgid=,command=']
    : ['-axo', 'pid=,pgid=,command=']
  const output = execFileSync('ps', args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  return output
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      pgid: Number(match[2]),
      command: match[3]
    }))
}

function waitForIdentityExit(identity) {
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!processIdentityIsCurrent(identity)) {
      return true
    }
    sleepSync(PROCESS_POLL_MS)
  }
  throw new Error(`Recorded benchmark helper ${identity.pid} did not exit`)
}

export function spawnBenchmarkProcess(executable, args, options) {
  return spawnSync(executable, args, {
    ...options,
    detached: true,
    killSignal: 'SIGKILL'
  })
}

export function runBenchmarkCleanupStages(stages) {
  const errors = []
  for (const stage of stages) {
    try {
      stage()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Benchmark trial cleanup failed')
  }
}

export function throwBenchmarkTrialFailures(trialError, cleanupError) {
  if (trialError && cleanupError) {
    throw new AggregateError([trialError, cleanupError], 'Electron trial and cleanup failed')
  }
  if (trialError) {
    throw trialError
  }
  if (cleanupError) {
    throw cleanupError
  }
}

export function parseBenchmarkTrialResult(serializedResult) {
  return JSON.parse(serializedResult)
}

export function benchmarkTrialNeedsCleanup(spawnResult, parsedResultAvailable) {
  return spawnResult?.status !== 0 || !parsedResultAvailable
}

const processGroupSignalOperations = {
  processIdentities,
  signalProcess: process.kill.bind(process)
}

function compensateStoppedGroup(pgid, groupState, operations) {
  const errors = []
  const targets = [
    groupState.stopped ? [-pgid, 'stopped'] : null,
    groupState.anchorPid ? [groupState.anchorPid, 'anchorPid'] : null
  ].filter(Boolean)
  for (const [pid, stateKey] of targets) {
    try {
      operations.signalProcess(pid, 'SIGCONT')
      groupState[stateKey] = stateKey === 'stopped' ? false : null
    } catch (error) {
      if (error?.code === 'ESRCH') {
        groupState[stateKey] = stateKey === 'stopped' ? false : null
      } else {
        errors.push(error)
      }
    }
  }
  return errors
}

export function signalValidatedProcessGroup(
  pgid,
  environmentFragment,
  signal,
  groupState = { stopped: false, anchorPid: null },
  operations = processGroupSignalOperations
) {
  if (!Number.isInteger(pgid) || pgid <= 0) {
    return false
  }
  let members
  try {
    members = operations.processIdentities(true).filter((identity) => identity.pgid === pgid)
  } catch (error) {
    const recoveryErrors = compensateStoppedGroup(pgid, groupState, operations)
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        'Benchmark process group recovery failed before validation'
      )
    }
    throw error
  }
  if (members.length === 0) {
    const recoveryErrors = compensateStoppedGroup(pgid, groupState, operations)
    if (recoveryErrors.length > 0) {
      throw new AggregateError(recoveryErrors, 'Benchmark missing process group recovery failed')
    }
    return false
  }
  if (members.some((identity) => !identity.command.includes(environmentFragment))) {
    const ownershipError = new Error('Benchmark process group no longer belongs to this trial')
    const recoveryErrors = compensateStoppedGroup(pgid, groupState, operations)
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [ownershipError, ...recoveryErrors],
        'Benchmark process group authority recovery failed'
      )
    }
    throw ownershipError
  }
  if (groupState.anchorPid) {
    try {
      operations.signalProcess(groupState.anchorPid, 'SIGCONT')
      groupState.anchorPid = null
    } catch (error) {
      if (error?.code === 'ESRCH') {
        groupState.anchorPid = null
      } else {
        throw new AggregateError([error], 'Benchmark pending anchor recovery failed')
      }
    }
  }
  const anchor = members[0]
  try {
    operations.signalProcess(anchor.pid, 'SIGSTOP')
    groupState.anchorPid = anchor.pid
    const stoppedAnchor = operations
      .processIdentities(true)
      .find((identity) => identity.pid === anchor.pid)
    if (!sameIdentity(stoppedAnchor, anchor)) {
      throw new Error('Benchmark process group anchor changed before signaling')
    }
    operations.signalProcess(-pgid, 'SIGSTOP')
    groupState.stopped = true
    groupState.anchorPid = null
    const stoppedMembers = operations
      .processIdentities(true)
      .filter((identity) => identity.pgid === pgid)
    if (
      stoppedMembers.length === 0 ||
      stoppedMembers.some((identity) => !identity.command.includes(environmentFragment))
    ) {
      throw new Error('Benchmark process group changed before signaling')
    }
    if (signal !== 'SIGSTOP') {
      operations.signalProcess(-pgid, signal)
      if (signal !== 'SIGKILL') {
        operations.signalProcess(-pgid, 'SIGCONT')
      }
      groupState.stopped = false
      groupState.anchorPid = null
    }
    return true
  } catch (error) {
    const recoveryErrors = compensateStoppedGroup(pgid, groupState, operations)
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        'Benchmark process group signal recovery failed'
      )
    }
    if (error.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

export function writeProcessRecord(recordPath, processIdentity) {
  const temporaryPath = `${recordPath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(processIdentity))
  renameSync(temporaryPath, recordPath)
}

export function processIdentityIsCurrent(identity) {
  return sameIdentity(processIdentity(identity?.pid), identity)
}

const processSignalOperations = {
  processIdentity,
  signalProcess: process.kill.bind(process)
}

export function signalProcessIdentity(
  identity,
  expectedCommandFragment,
  signal,
  operations = processSignalOperations
) {
  validateDetachedIdentity(identity, expectedCommandFragment)
  const currentIdentity = operations.processIdentity(identity.pid)
  if (!currentIdentity) {
    return false
  }
  if (!sameIdentity(currentIdentity, identity)) {
    throw new Error('Recorded benchmark helper PID now belongs to another process')
  }
  let stopped = false
  try {
    operations.signalProcess(identity.pid, 'SIGSTOP')
    stopped = true
    const stoppedIdentity = operations.processIdentity(identity.pid)
    if (!sameIdentity(stoppedIdentity, identity)) {
      throw new Error('Recorded benchmark helper PID changed before signaling')
    }
    operations.signalProcess(-identity.pgid, signal)
    if (signal !== 'SIGKILL') {
      operations.signalProcess(-identity.pgid, 'SIGCONT')
    }
    stopped = false
    return true
  } catch (error) {
    let resumeError
    if (stopped) {
      try {
        operations.signalProcess(identity.pid, 'SIGCONT')
      } catch (caught) {
        if (caught?.code !== 'ESRCH') {
          resumeError = caught
        }
      }
    }
    if (resumeError) {
      throw new AggregateError([error, resumeError], 'Benchmark helper signal recovery failed')
    }
    if (error.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

export function killRecordedProcess(recordPath, expectedCommandFragment) {
  if (!existsSync(recordPath)) {
    return false
  }
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  if (!signalProcessIdentity(record, expectedCommandFragment, 'SIGKILL')) {
    return false
  }
  return waitForIdentityExit(record)
}

export function killRecordedAndMatchingProcesses(
  recordPath,
  recordedCommandFragment,
  matchingCommandFragments
) {
  const errors = []
  try {
    killRecordedProcess(recordPath, recordedCommandFragment)
  } catch (error) {
    errors.push(error)
  }
  try {
    killProcessMatchingCommand(matchingCommandFragments)
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Benchmark helper cleanup failed')
  }
}

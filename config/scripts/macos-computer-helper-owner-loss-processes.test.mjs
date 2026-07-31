import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  benchmarkTrialNeedsCleanup,
  killProcessMatchingCommand,
  killRecordedAndMatchingProcesses,
  killRecordedProcess,
  parseBenchmarkTrialResult,
  processIdentity,
  runBenchmarkCleanupStages,
  signalProcessIdentity,
  signalValidatedProcessGroup,
  spawnBenchmarkProcess,
  throwBenchmarkTrialFailures,
  writeProcessRecord
} from './macos-computer-helper-owner-loss-processes.mjs'
import { cleanupOwnerLossTrial } from './macos-computer-helper-owner-loss-trial-cleanup.mjs'

const describeMacOS = process.platform === 'darwin' ? describe : describe.skip
const spawnedPids = new Set()
const temporaryDirectories = new Set()

afterEach(() => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  spawnedPids.clear()
  for (const temporaryDirectory of temporaryDirectories) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
  temporaryDirectories.clear()
})

describeMacOS('macOS helper owner-loss benchmark process cleanup', () => {
  it('enforces a hard timeout when the trial ignores SIGTERM', () => {
    const startedAt = Date.now()
    const result = spawnBenchmarkProcess(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
      { stdio: 'ignore', timeout: 100 }
    )
    expect(result.error?.code).toBe('ETIMEDOUT')
    expect(result.signal).toBe('SIGKILL')
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(() => process.kill(result.pid, 0)).toThrow()
  })

  it('runs every cleanup stage before aggregating errors', () => {
    const completed = []
    let thrown

    try {
      runBenchmarkCleanupStages([
        () => {
          completed.push(1)
          throw new Error('first failure')
        },
        () => {
          completed.push(2)
        },
        () => {
          completed.push(3)
          throw new Error('last failure')
        }
      ])
    } catch (error) {
      thrown = error
    }
    expect(completed).toEqual([1, 2, 3])
    expect(thrown).toBeInstanceOf(AggregateError)
    expect(thrown.errors.map((error) => error.message)).toEqual(['first failure', 'last failure'])
  })

  it('preserves malformed-result and cleanup failures', () => {
    let trialError
    try {
      parseBenchmarkTrialResult('{malformed')
    } catch (error) {
      trialError = error
    }
    const cleanupError = new Error('cleanup failed')
    let thrown

    try {
      throwBenchmarkTrialFailures(trialError, cleanupError)
    } catch (error) {
      thrown = error
    }
    expect(trialError).toBeInstanceOf(SyntaxError)
    expect(thrown).toBeInstanceOf(AggregateError)
    expect(thrown.errors).toEqual([trialError, cleanupError])
  })

  it('cleans up a status-zero trial whose result could not be parsed', () => {
    expect(benchmarkTrialNeedsCleanup(undefined, false)).toBe(true)
    expect(benchmarkTrialNeedsCleanup({ status: 0 }, false)).toBe(true)
    expect(benchmarkTrialNeedsCleanup({ status: 0 }, true)).toBe(false)
    expect(benchmarkTrialNeedsCleanup({ status: 1 }, true)).toBe(true)
  })

  it('removes a launcher directory after partial trial setup', () => {
    const launcherDir = mkdtempSync(path.join(tmpdir(), 'orca-owner-partial-setup-test-'))
    temporaryDirectories.add(launcherDir)

    const cleanup = cleanupOwnerLossTrial({
      failed: true,
      launcherDir,
      outputPaths: []
    })

    expect(cleanup.error).toBeUndefined()
    expect(existsSync(launcherDir)).toBe(false)
    temporaryDirectories.delete(launcherDir)
  })

  it('kills a timed-out trial group only after validating its environment', async () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'orca-owner-benchmark-group-test-'))
    temporaryDirectories.add(temporaryDirectory)
    const childPidPath = path.join(temporaryDirectory, 'child.pid')
    const environmentName = `ORCA_OWNER_GROUP_${process.pid}`
    const environmentValue = `${Date.now()}`
    const fixture = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore'
      })
      writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid))
      setInterval(() => {}, 1000)
    `
    const result = spawnBenchmarkProcess(process.execPath, ['-e', fixture], {
      env: { ...process.env, [environmentName]: environmentValue },
      stdio: 'ignore',
      timeout: 100
    })
    const childPid = Number(readFileSync(childPidPath, 'utf8'))
    spawnedPids.add(childPid)
    const environmentFragment = `${environmentName}=${environmentValue}`
    const groupState = { stopped: false }

    expect(() =>
      signalValidatedProcessGroup(result.pid, `${environmentName}=wrong`, 'SIGSTOP')
    ).toThrow('Benchmark process group no longer belongs to this trial')
    expect(() => process.kill(childPid, 0)).not.toThrow()
    expect(
      signalValidatedProcessGroup(result.pid, environmentFragment, 'SIGSTOP', groupState)
    ).toBe(true)
    expect(
      signalValidatedProcessGroup(result.pid, environmentFragment, 'SIGKILL', groupState)
    ).toBe(true)
    await expect
      .poll(() => {
        try {
          process.kill(childPid, 0)
          return true
        } catch {
          return false
        }
      })
      .toBe(false)

    spawnedPids.delete(childPid)
  })

  it('resumes the group after post-stop revalidation fails', () => {
    const marker = 'ORCA_OWNER_GROUP=trial'
    const members = [
      { pid: 41, pgid: 41, command: `/launcher ${marker}` },
      { pid: 42, pgid: 41, command: `/child ${marker}` }
    ]
    const signals = []
    let scanCount = 0

    expect(() =>
      signalValidatedProcessGroup(
        41,
        marker,
        'SIGKILL',
        { stopped: false },
        {
          processIdentities: () => {
            scanCount += 1
            if (scanCount === 3) {
              throw new Error('transient group inspection failure')
            }
            return members
          },
          signalProcess: (pid, signal) => {
            signals.push([pid, signal])
          }
        }
      )
    ).toThrow('transient group inspection failure')
    expect(signals).toEqual([
      [41, 'SIGSTOP'],
      [-41, 'SIGSTOP'],
      [-41, 'SIGCONT']
    ])
  })

  it('compensates a possible stop after group anchor replacement', () => {
    const marker = 'ORCA_OWNER_GROUP=trial'
    const anchor = { pid: 41, pgid: 41, command: `/launcher ${marker}` }
    const replacement = { pid: 41, pgid: 99, command: '/unrelated' }
    const signals = []
    let scanCount = 0

    expect(() =>
      signalValidatedProcessGroup(
        41,
        marker,
        'SIGKILL',
        { stopped: false },
        {
          processIdentities: () => {
            scanCount += 1
            return scanCount === 1 ? [anchor] : [replacement]
          },
          signalProcess: (pid, signal) => {
            signals.push([pid, signal])
          }
        }
      )
    ).toThrow('Benchmark process group anchor changed before signaling')
    expect(signals).toEqual([
      [41, 'SIGSTOP'],
      [41, 'SIGCONT']
    ])
  })

  it('resumes a previously frozen group when final inspection fails', () => {
    const marker = 'ORCA_OWNER_GROUP=trial'
    const members = [{ pid: 41, pgid: 41, command: `/launcher ${marker}` }]
    const signals = []
    let scanCount = 0
    const groupState = { stopped: false }
    const operations = {
      processIdentities: () => {
        scanCount += 1
        if (scanCount === 4) {
          throw new Error('transient final inspection failure')
        }
        return members
      },
      signalProcess: (pid, signal) => {
        signals.push([pid, signal])
      }
    }

    expect(signalValidatedProcessGroup(41, marker, 'SIGSTOP', groupState, operations)).toBe(true)
    expect(() =>
      signalValidatedProcessGroup(41, marker, 'SIGKILL', groupState, operations)
    ).toThrow('transient final inspection failure')
    expect(signals).toEqual([
      [41, 'SIGSTOP'],
      [-41, 'SIGSTOP'],
      [-41, 'SIGCONT']
    ])
  })

  it('resumes a previously frozen group when final anchor stop fails', () => {
    const marker = 'ORCA_OWNER_GROUP=trial'
    const members = [
      { pid: 41, pgid: 41, command: `/launcher ${marker}` },
      { pid: 42, pgid: 41, command: `/child ${marker}` }
    ]
    const signals = []
    let finalCall = false
    const groupState = { stopped: false }
    const missingProcessError = Object.assign(new Error('anchor exited'), { code: 'ESRCH' })
    const operations = {
      processIdentities: () => members,
      signalProcess: (pid, signal) => {
        signals.push([pid, signal])
        if (finalCall && pid === 41 && signal === 'SIGSTOP') {
          throw missingProcessError
        }
      }
    }

    expect(signalValidatedProcessGroup(41, marker, 'SIGSTOP', groupState, operations)).toBe(true)
    finalCall = true
    expect(signalValidatedProcessGroup(41, marker, 'SIGKILL', groupState, operations)).toBe(false)
    expect(signals.at(-1)).toEqual([-41, 'SIGCONT'])
  })

  it('resumes a previously frozen group after final anchor replacement', () => {
    const marker = 'ORCA_OWNER_GROUP=trial'
    const anchor = { pid: 41, pgid: 41, command: `/launcher ${marker}` }
    const child = { pid: 42, pgid: 41, command: `/child ${marker}` }
    const replacement = { pid: 41, pgid: 99, command: '/unrelated' }
    const signals = []
    let scanCount = 0
    const groupState = { stopped: false }
    const operations = {
      processIdentities: () => {
        scanCount += 1
        return scanCount === 5 ? [replacement, child] : [anchor, child]
      },
      signalProcess: (pid, signal) => {
        signals.push([pid, signal])
      }
    }

    expect(signalValidatedProcessGroup(41, marker, 'SIGSTOP', groupState, operations)).toBe(true)
    expect(() =>
      signalValidatedProcessGroup(41, marker, 'SIGKILL', groupState, operations)
    ).toThrow('Benchmark process group anchor changed before signaling')
    expect(signals.slice(-2)).toEqual([
      [-41, 'SIGCONT'],
      [41, 'SIGCONT']
    ])
  })

  it('kills a recorded helper in a separate process group', async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), 'orca-owner-benchmark-cleanup-test-')
    )
    temporaryDirectories.add(temporaryDirectory)
    const recordPath = path.join(temporaryDirectory, 'helper.json')
    const marker = `orca-owner-cleanup-${process.pid}-${Date.now()}`
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)', marker], {
      detached: true,
      stdio: 'ignore'
    })
    spawnedPids.add(helper.pid)
    helper.unref()
    const exited = new Promise((resolve) => helper.once('exit', resolve))
    const command = execFileSync('ps', ['-p', String(helper.pid), '-o', 'command='], {
      encoding: 'utf8'
    }).trim()
    const processGroup = Number(
      execFileSync('ps', ['-p', String(helper.pid), '-o', 'pgid='], {
        encoding: 'utf8'
      }).trim()
    )
    writeProcessRecord(recordPath, { pid: helper.pid, pgid: processGroup, command })

    expect(processGroup).toBe(helper.pid)
    expect(killRecordedProcess(recordPath, marker)).toBe(true)
    await exited
    expect(() => process.kill(helper.pid, 0)).toThrow()

    spawnedPids.delete(helper.pid)
  })

  it('kills every unrecorded helper using its unique trial command', async () => {
    const marker = `orca-owner-unrecorded-${process.pid}-${Date.now()}`
    const helpers = Array.from({ length: 2 }, () =>
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)', marker], {
        detached: true,
        stdio: 'ignore'
      })
    )
    for (const helper of helpers) {
      spawnedPids.add(helper.pid)
      helper.unref()
    }
    const exited = Promise.all(
      helpers.map((helper) => new Promise((resolve) => helper.once('exit', resolve)))
    )

    expect(killProcessMatchingCommand([process.execPath, marker])).toBe(true)
    await exited
    for (const helper of helpers) {
      expect(() => process.kill(helper.pid, 0)).toThrow()
      spawnedPids.delete(helper.pid)
    }
  })

  it('continues exact-match cleanup after an earlier match fails', () => {
    const marker = `orca-owner-multiple-${process.pid}-${Date.now()}`
    const matches = [
      { pid: 41, pgid: 41, command: `/helper ${marker}` },
      { pid: 42, pgid: 42, command: `/helper ${marker}` }
    ]
    const attempted = []
    let scanCount = 0

    expect(() =>
      killProcessMatchingCommand(['/helper', marker], {
        processIdentities: () => {
          scanCount += 1
          return scanCount === 1 ? matches : [matches[0]]
        },
        signalProcessIdentity: (identity) => {
          attempted.push(identity.pid)
          if (identity.pid === matches[0].pid) {
            throw new Error('identity changed')
          }
          return true
        },
        waitForIdentityExit: () => {}
      })
    ).toThrow('Benchmark exact-command cleanup failed')
    expect(attempted).toEqual([41, 42])
  })

  it('does not treat an identity query failure as process exit', () => {
    const queryError = new Error('transient ps failure')

    expect(() =>
      processIdentity(41, {
        executePs: () => {
          throw queryError
        },
        signalProcess: () => {}
      })
    ).toThrow(queryError)
  })

  it('resumes a helper when post-stop identity inspection fails', () => {
    const identity = { pid: 41, pgid: 41, command: '/helper marker' }
    const signals = []
    let inspectionCount = 0

    expect(() =>
      signalProcessIdentity(identity, 'marker', 'SIGKILL', {
        processIdentity: () => {
          inspectionCount += 1
          if (inspectionCount === 2) {
            throw new Error('transient ps failure after stop')
          }
          return identity
        },
        signalProcess: (pid, signal) => {
          signals.push([pid, signal])
        }
      })
    ).toThrow('transient ps failure after stop')
    expect(signals).toEqual([
      [41, 'SIGSTOP'],
      [41, 'SIGCONT']
    ])
  })

  it('compensates a possible stop after helper PID replacement', () => {
    const identity = { pid: 41, pgid: 41, command: '/helper marker' }
    const replacement = { pid: 41, pgid: 41, command: '/unrelated' }
    const signals = []
    let inspectionCount = 0

    expect(() =>
      signalProcessIdentity(identity, 'marker', 'SIGKILL', {
        processIdentity: () => {
          inspectionCount += 1
          return inspectionCount === 1 ? identity : replacement
        },
        signalProcess: (pid, signal) => {
          signals.push([pid, signal])
        }
      })
    ).toThrow('Recorded benchmark helper PID changed before signaling')
    expect(signals).toEqual([
      [41, 'SIGSTOP'],
      [41, 'SIGCONT']
    ])
  })

  it('preserves helper identity errors when compensation fails', () => {
    const identity = { pid: 41, pgid: 41, command: '/helper marker' }
    const replacement = { pid: 41, pgid: 41, command: '/unrelated' }
    let inspectionCount = 0
    let thrown

    try {
      signalProcessIdentity(identity, 'marker', 'SIGKILL', {
        processIdentity: () => {
          inspectionCount += 1
          return inspectionCount === 1 ? identity : replacement
        },
        signalProcess: (_pid, signal) => {
          if (signal === 'SIGCONT') {
            throw new Error('resume denied')
          }
        }
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect(thrown.errors.map((error) => error.message)).toEqual([
      'Recorded benchmark helper PID changed before signaling',
      'resume denied'
    ])
  })

  it('treats a missing PID as process exit after an identity query failure', () => {
    const missingProcessError = Object.assign(new Error('missing process'), { code: 'ESRCH' })

    expect(
      processIdentity(41, {
        executePs: () => {
          throw new Error('ps found no process')
        },
        signalProcess: () => {
          throw missingProcessError
        }
      })
    ).toBeNull()
  })

  it('runs unique-command cleanup after an invalid process record', async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), 'orca-owner-benchmark-fallback-test-')
    )
    temporaryDirectories.add(temporaryDirectory)
    const recordPath = path.join(temporaryDirectory, 'helper.json')
    const marker = `orca-owner-invalid-record-${process.pid}-${Date.now()}`
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)', marker], {
      detached: true,
      stdio: 'ignore'
    })
    spawnedPids.add(helper.pid)
    helper.unref()
    const exited = new Promise((resolve) => helper.once('exit', resolve))
    const command = execFileSync('ps', ['-p', String(helper.pid), '-o', 'command='], {
      encoding: 'utf8'
    }).trim()
    writeProcessRecord(recordPath, { pid: helper.pid, pgid: helper.pid - 1, command })

    expect(() =>
      killRecordedAndMatchingProcesses(recordPath, marker, [process.execPath, marker])
    ).toThrow('Recorded benchmark helper identity is invalid')
    await exited
    expect(() => process.kill(helper.pid, 0)).toThrow()

    spawnedPids.delete(helper.pid)
  })

  it('rejects a record that is not a detached process-group identity', () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), 'orca-owner-benchmark-identity-test-')
    )
    temporaryDirectories.add(temporaryDirectory)
    const recordPath = path.join(temporaryDirectory, 'helper.json')
    const marker = `orca-owner-invalid-identity-${process.pid}-${Date.now()}`
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)', marker], {
      stdio: 'ignore'
    })
    spawnedPids.add(helper.pid)
    helper.unref()
    const command = execFileSync('ps', ['-p', String(helper.pid), '-o', 'command='], {
      encoding: 'utf8'
    }).trim()
    writeProcessRecord(recordPath, { pid: helper.pid, pgid: helper.pid - 1, command })

    expect(() => killRecordedProcess(recordPath, marker)).toThrow(
      'Recorded benchmark helper identity is invalid'
    )
    expect(() => process.kill(helper.pid, 0)).not.toThrow()
  })
})

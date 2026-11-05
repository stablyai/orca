import { describe, expect, it } from 'vitest'
import { signalValidatedProcessGroup } from './macos-computer-helper-owner-loss-processes.mjs'

describe('macOS helper owner-loss benchmark group recovery', () => {
  it('retains uncertain stop state across cleanup stage failures', () => {
    const marker = 'ORCA_OWNER_GROUP=trial'
    const members = [{ pid: 41, pgid: 41, command: `/launcher ${marker}` }]
    const groupState = { stopped: false }
    let scanCount = 0
    let continueAttempts = 0
    const operations = {
      processIdentities: () => {
        scanCount += 1
        if (scanCount >= 3) {
          throw new Error(
            scanCount === 3 ? 'post-stop inspection failed' : 'final inspection failed'
          )
        }
        return members
      },
      signalProcess: (pid, signal) => {
        if (pid === -41 && signal === 'SIGCONT') {
          continueAttempts += 1
          if (continueAttempts === 1) {
            throw new Error('first compensation failed')
          }
        }
      }
    }

    expect(() =>
      signalValidatedProcessGroup(41, marker, 'SIGSTOP', groupState, operations)
    ).toThrow('Benchmark process group signal recovery failed')
    expect(groupState.stopped).toBe(true)
    expect(() =>
      signalValidatedProcessGroup(41, marker, 'SIGKILL', groupState, operations)
    ).toThrow('final inspection failed')
    expect(continueAttempts).toBe(2)
    expect(groupState.stopped).toBe(false)
  })

  it('retains an uncertain anchor stop across cleanup stage failures', () => {
    const marker = 'ORCA_OWNER_GROUP=trial'
    const members = [{ pid: 41, pgid: 41, command: `/launcher ${marker}` }]
    const groupState = { stopped: false, anchorPid: null }
    let scanCount = 0
    let continueAttempts = 0
    const operations = {
      processIdentities: () => {
        scanCount += 1
        if (scanCount >= 2) {
          throw new Error(
            scanCount === 2 ? 'post-anchor inspection failed' : 'final inspection failed'
          )
        }
        return members
      },
      signalProcess: (pid, signal) => {
        if (pid === 41 && signal === 'SIGCONT') {
          continueAttempts += 1
          if (continueAttempts === 1) {
            throw new Error('first anchor compensation failed')
          }
        }
      }
    }

    expect(() =>
      signalValidatedProcessGroup(41, marker, 'SIGSTOP', groupState, operations)
    ).toThrow('Benchmark process group signal recovery failed')
    expect(groupState.anchorPid).toBe(41)
    expect(() =>
      signalValidatedProcessGroup(41, marker, 'SIGKILL', groupState, operations)
    ).toThrow('final inspection failed')
    expect(continueAttempts).toBe(2)
    expect(groupState.anchorPid).toBeNull()
  })

  it('recovers a retained anchor before selecting a new one', () => {
    const marker = 'ORCA_OWNER_GROUP=trial'
    const firstAnchor = { pid: 41, pgid: 41, command: `/launcher ${marker}` }
    const finalAnchor = { pid: 42, pgid: 41, command: `/child ${marker}` }
    const groupState = { stopped: false, anchorPid: null }
    let scanCount = 0
    let firstAnchorContinues = 0
    const operations = {
      processIdentities: () => {
        scanCount += 1
        if (scanCount === 2) {
          throw new Error('post-anchor inspection failed')
        }
        return scanCount === 1 ? [firstAnchor] : [finalAnchor]
      },
      signalProcess: (pid, signal) => {
        if (pid === 41 && signal === 'SIGCONT') {
          firstAnchorContinues += 1
          if (firstAnchorContinues === 1) {
            throw new Error('first anchor compensation failed')
          }
        }
      }
    }

    expect(() =>
      signalValidatedProcessGroup(41, marker, 'SIGSTOP', groupState, operations)
    ).toThrow('Benchmark process group signal recovery failed')
    expect(signalValidatedProcessGroup(41, marker, 'SIGKILL', groupState, operations)).toBe(true)
    expect(firstAnchorContinues).toBe(2)
    expect(groupState).toEqual({ stopped: false, anchorPid: null })
  })

  it('preserves group authority errors when compensation fails', () => {
    const marker = 'ORCA_OWNER_GROUP=trial'
    const ownershipError = 'Benchmark process group no longer belongs to this trial'
    let thrown

    try {
      signalValidatedProcessGroup(
        41,
        marker,
        'SIGKILL',
        { stopped: true },
        {
          processIdentities: () => [{ pid: 41, pgid: 41, command: '/unrelated' }],
          signalProcess: () => {
            throw new Error('resume denied')
          }
        }
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect(thrown.errors.map((error) => error.message)).toEqual([ownershipError, 'resume denied'])
  })
})

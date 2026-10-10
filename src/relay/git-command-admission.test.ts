import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { GitAdmissionScheduler } from '../shared/git-admission-scheduler'

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess: capture }))

import {
  _resetRelayGitAdmissionForTests,
  runGitToTermination
} from './git-handler-command-termination'

describe('relay Git command ownership', () => {
  let scheduler: GitAdmissionScheduler
  const success = { code: 0, signal: null, stdout: 'result', stderr: '', timedOut: false }

  beforeEach(() => {
    scheduler = new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 })
    _resetRelayGitAdmissionForTests(scheduler)
    capture.mockReset()
  })
  afterEach(() => _resetRelayGitAdmissionForTests())

  it('bounds reads while preserving explicit write and network timeout policy', async () => {
    capture.mockImplementation(async (spec: ProcessSpec) => {
      spec.onChildTerminated?.()
      return success
    })
    await runGitToTermination(
      ['-c', 'core.quotePath=false', 'show', 'HEAD:file'],
      { cwd: '/repo' },
      undefined
    )
    await runGitToTermination(['fetch', 'origin'], { cwd: '/repo' }, undefined)
    await runGitToTermination(['reset', '--quiet'], { cwd: '/repo', timeout: 800 }, undefined)
    expect(capture.mock.calls.map(([spec]) => spec.timeoutMs)).toEqual([120_000, null, 800])
    expect(capture.mock.calls[0][0]).toMatchObject({
      terminationBarrier: true,
      killOnOutputLimit: true
    })
  })

  it('cancels a queued read without spawning or releasing an active child', async () => {
    let finish!: () => void
    capture.mockImplementationOnce(
      (spec: ProcessSpec) =>
        new Promise((resolve) => {
          finish = () => {
            spec.onChildTerminated?.()
            resolve(success)
          }
        })
    )
    const active = runGitToTermination(['show', 'HEAD:file'], { cwd: '/repo' }, undefined)
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    const controller = new AbortController()
    const queued = runGitToTermination(
      ['show', 'HEAD:other'],
      { cwd: '/repo', signal: controller.signal },
      undefined
    )
    const rejection = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(capture).toHaveBeenCalledTimes(1)
    expect(scheduler.snapshot()).toMatchObject({ queued: 0, budgets: { general: { baseUsed: 1 } } })
    finish()
    await active
    expect(scheduler.snapshot().budgets.general.baseUsed).toBe(0)
  })

  it('holds admission after a capture rejects until child termination is reported', async () => {
    let reportTermination: (() => void) | undefined
    capture.mockImplementationOnce(async (spec: ProcessSpec) => {
      reportTermination = spec.onChildTerminated
      throw new Error('capture failed before close')
    })
    await expect(runGitToTermination(['status'], { cwd: '/repo' }, undefined)).rejects.toThrow(
      'before close'
    )
    expect(scheduler.snapshot().budgets.general.baseUsed).toBe(1)
    reportTermination?.()
    expect(scheduler.snapshot().budgets.general.baseUsed).toBe(0)
  })

  it('rejects truncated zero-exit output instead of parsing an incomplete result', async () => {
    capture.mockImplementationOnce(async (spec: ProcessSpec) => {
      spec.onChildTerminated?.()
      return { ...success, outputTruncated: true }
    })
    await expect(runGitToTermination(['log'], { cwd: '/repo' }, undefined)).rejects.toMatchObject({
      code: 'ENOBUFS'
    })
  })

  it('allows truncated diagnostic tails without terminating a successful clone', async () => {
    capture.mockImplementationOnce(async (spec: ProcessSpec, mode: string) => {
      expect(mode).toBe('tail')
      expect(spec).toMatchObject({ maxOutputBytes: 4096, killOnOutputLimit: false })
      spec.onChildTerminated?.()
      return { ...success, outputTruncated: true }
    })
    await expect(
      runGitToTermination(
        ['clone', '--progress', 'source', 'target'],
        { cwd: '/repo', maxBuffer: 4096, outputCapture: 'tail' },
        undefined
      )
    ).resolves.toEqual({ stdout: 'result', stderr: '' })
    expect(scheduler.snapshot().budgets.network.baseUsed).toBe(0)
  })

  it.each([
    { code: 128, timedOut: false, signal: null, message: 'fatal: repository unavailable' },
    { code: null, timedOut: true, signal: 'SIGTERM', message: 'git clone timed out.' }
  ])('preserves a noisy clone failure or deadline: $message', async (failure) => {
    capture.mockImplementationOnce(async (spec: ProcessSpec) => {
      spec.onChildTerminated?.()
      return {
        ...success,
        ...failure,
        stderr: 'fatal: repository unavailable',
        outputTruncated: true
      }
    })
    await expect(
      runGitToTermination(['clone'], { cwd: '/repo', outputCapture: 'tail' }, undefined)
    ).rejects.toMatchObject({ code: failure.code, message: failure.message })
  })

  it('returns captured bytes without round-tripping through UTF-8', async () => {
    const bytes = Buffer.from([0, 255, 254, 128, 65])
    capture.mockImplementationOnce(async (spec: ProcessSpec) => {
      expect(spec.captureStdoutAsBytes).toBe(true)
      spec.onChildTerminated?.()
      return { ...success, stdout: '', stdoutBytes: bytes }
    })
    const result = await runGitToTermination(
      ['show', 'HEAD:file'],
      { cwd: '/repo', captureStdoutAsBytes: true },
      undefined
    )
    expect(result.stdoutBytes).toEqual(bytes)
  })
})

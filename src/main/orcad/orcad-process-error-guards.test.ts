import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCAD_EXIT_FAILED } from './orcad-exit-code'
import { installOrcadProcessErrorGuards } from './orcad-process-error-guards'

const uninstalls: (() => void)[] = []

function install(
  trigger: Parameters<typeof installOrcadProcessErrorGuards>[0],
  now: () => number = Date.now
) {
  const rejectionBefore = process.listeners('unhandledRejection')
  const exceptionBefore = process.listeners('uncaughtException')
  uninstalls.push(installOrcadProcessErrorGuards(trigger, now))
  const onRejection = process
    .listeners('unhandledRejection')
    .find((listener) => !rejectionBefore.includes(listener))
  const onException = process
    .listeners('uncaughtException')
    .find((listener) => !exceptionBefore.includes(listener))
  if (!onRejection || !onException) {
    throw new Error('guards were not installed')
  }
  return {
    reject: (reason: unknown) => onRejection(reason, Promise.resolve()),
    throwUncaught: (error: Error) => onException(error, 'uncaughtException')
  }
}

function captureExit() {
  return vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process exit')
  })
}

afterEach(() => {
  for (const uninstall of uninstalls.splice(0)) {
    uninstall()
  }
  vi.restoreAllMocks()
})

describe('orcad process error guards (STA-5606)', () => {
  it('logs an unhandled rejection and keeps the server up', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = captureExit()
    const shutdown = vi.fn(() => true)
    const guards = install(() => shutdown)

    guards.reject(new Error('ssh reconnect failed'))

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('unhandled rejection; continuing'),
      expect.objectContaining({ message: 'ssh reconnect failed' })
    )
    expect(shutdown).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('caps a rejection storm and reports how many it suppressed', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let clock = 1_000
    const guards = install(
      () => null,
      () => clock
    )
    for (let index = 0; index < 25; index += 1) {
      guards.reject(new Error(`rejection ${index}`))
    }
    expect(log).toHaveBeenCalledTimes(20)
    clock += 60_000
    guards.reject(new Error('after the window'))
    expect(log).toHaveBeenCalledTimes(21)
    expect(String(log.mock.calls[20]?.[0])).toContain('5 more suppressed')
  })

  it('survives a native PTY exception and a closed output pipe, logging each', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = captureExit()
    const shutdown = vi.fn(() => true)
    const guards = install(() => shutdown)

    guards.throwUncaught(new Error('Pty process exited'))
    const pipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    guards.throwUncaught(pipe)
    guards.throwUncaught(pipe)

    expect(shutdown).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('native PTY exception'),
      expect.anything()
    )
    expect(log.mock.calls.filter(([line]) => String(line).includes('EPIPE'))).toHaveLength(1)
  })

  it('stops gracefully with a failing exit code on any other uncaught exception', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const shutdown = vi.fn(() => true)
    const guards = install(() => shutdown)

    guards.throwUncaught(new TypeError('cannot read properties of undefined'))

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('uncaught exception (fatal)'),
      expect.any(TypeError)
    )
    expect(shutdown).toHaveBeenCalledWith('uncaught exception', undefined, ORCAD_EXIT_FAILED)
  })

  it('exits at once when the fault lands before the stop trigger exists', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = captureExit()
    const guards = install(() => null)

    expect(() => guards.throwUncaught(new Error('early'))).toThrow('process exit')
    expect(exit).toHaveBeenCalledWith(ORCAD_EXIT_FAILED)
  })
})

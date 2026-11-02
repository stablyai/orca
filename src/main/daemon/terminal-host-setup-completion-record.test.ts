import './mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSetupCompletionScanner } from '../runtime/orchestration/setup-completion-signal'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']

describe('TerminalHost prepared Setup completion record', () => {
  let host: TerminalHost | undefined

  afterEach(async () => {
    vi.useRealTimers()
    await host?.dispose()
  })

  it('never draws or saves the bound record, while its raw scanner still completes Setup', async () => {
    vi.useFakeTimers()
    const attemptId = '2f1c7a52-9d0e-4b8a-a6f3-5c1e0d9b7a44'
    let emit: (data: string) => void = () => {}
    let exit: (code: number) => void = () => {}
    const spawnSubprocess = vi.fn<SpawnSubprocess>((opts) => {
      // Like the native spawn: the raw observer reads every byte before the session does.
      const raw = opts.rawSpawnObserver?.()
      let sessionData: (data: string) => void = () => {}
      emit = (data) => {
        raw?.onData(data)
        sessionData(data)
      }
      return {
        pid: 4242,
        getForegroundProcess: () => null,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        terminateOwnedTree: () => 'unavailable' as const,
        forceKill: vi.fn(),
        signal: vi.fn(),
        onData: (cb) => {
          sessionData = cb
        },
        onExit: (cb) => {
          exit = cb
        },
        dispose: vi.fn()
      } as SubprocessHandle
    })
    host = new TerminalHost({ spawnSubprocess })
    const completed = vi.fn()
    const scanner = createSetupCompletionScanner(attemptId, completed)
    let rendered = ''
    await host.createOrAttach({
      sessionId: 'prepared-setup',
      cols: 120,
      rows: 24,
      setupCompletionToken: attemptId,
      rawSpawnObserver: () => ({ onData: scanner.scan, onExit: vi.fn(), onSelected: vi.fn() }),
      streamClient: { onData: (data) => (rendered += data), onExit: vi.fn() }
    })

    const lookAlike = '__ORCA_SETUP_COMPLETE__:another-attempt:0\r\n'
    for (const chunk of [
      'installing deps\r\n',
      lookAlike,
      '\r\n__ORCA_SETUP_COMP',
      `LETE__:${attemptId}:`,
      '0\r',
      '\nready\r\n__ORCA_SETUP'
    ]) {
      emit(chunk)
    }
    expect(completed).toHaveBeenCalledWith(0)
    // A tail that only starts like the record is released after a quiet moment.
    vi.advanceTimersByTime(100)
    emit(`_PART\r\n__ORCA_SETUP_COMPLETE__:${attemptId}:0\r\n$ `)
    const shown = `installing deps\r\n${lookAlike}\r\nready\r\n__ORCA_SETUP_PART\r\n$ `
    expect(rendered).toBe(shown)

    // Main restarted while the daemon kept Setup: reattach reads the daemon's saved screen.
    let after = ''
    const exited = vi.fn()
    const reattached = await host.createOrAttach({
      sessionId: 'prepared-setup',
      cols: 120,
      rows: 24,
      streamClient: { onData: (data) => (after += data), onExit: exited }
    })
    expect(reattached.isNew).toBe(false)
    const saved = JSON.stringify(reattached.snapshot)
    expect(saved).not.toContain(attemptId)
    expect(saved).toContain('another-attempt')
    expect(saved).toContain('ready')

    // Exit still settles, after any held text reaches the screen.
    emit('done __ORCA_')
    expect(after).toBe('done ')
    exit(0)
    expect(after).toBe('done __ORCA_')
    expect(exited).toHaveBeenCalledWith(0, reattached.incarnationId, expect.anything())
  })
})

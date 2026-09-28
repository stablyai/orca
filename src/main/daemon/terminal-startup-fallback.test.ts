import './mock-descendant-sweep'
import { expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import { spawnNativeDaemonPty } from './pty-subprocess/native-pty-spawn'
import { createMockSubprocess, waitFor } from './daemon-pty-adapter-test-harness'
import type { BunPtyProcess } from './pty-subprocess/bun-pty-process-contract'

it.each([false, true])(
  'isolates failed Windows shell output and retains failed cleanup (%s)',
  async (cleanupFails) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const attempts: ReturnType<typeof makeAttempt>[] = []
    const onData = vi.fn()
    const onExit = vi.fn()
    const host = new TerminalHost({
      spawnSubprocess: async (opts) => {
        let selected = createMockSubprocess()
        await spawnNativeDaemonPty(
          {
            shellPath: 'pwsh.exe',
            shellArgs: [],
            spawnCwd: '.',
            env: {},
            cols: 80,
            rows: 24,
            windowsFallbackAttempts: [
              {
                shellPath: 'pwsh.exe',
                shellArgs: [],
                effectiveCwd: '.',
                validationCwd: '.',
                startupCommandDeliveredInShellArgs: false
              },
              {
                shellPath: 'cmd.exe',
                shellArgs: [],
                effectiveCwd: '.',
                validationCwd: '.',
                startupCommandDeliveredInShellArgs: false
              }
            ],
            onSpawnAttempt: (_spawned, discardNative) => {
              selected = attempts.at(-1)!.handle
              return opts.onSpawnAttempt!(() => selected, discardNative)
            }
          },
          {
            canUseBunPty: () => true,
            spawnBunPty: () => {
              const attempt = makeAttempt()
              attempts.push(attempt)
              return attempt.process
            }
          }
        )
        return selected
      }
    })
    try {
      const pending = host.createOrAttach({
        sessionId: 'fallback',
        cols: 80,
        rows: 24,
        streamClient: { onData, onExit }
      })
      await waitFor(() => attempts.length === 1)
      attempts[0]!.handle._simulateData('PRIVATE_PRIMARY')
      if (cleanupFails) {
        attempts[0]!.forceKill.mockImplementation(() => {
          throw new Error('still live')
        })
        const rejected = expect(pending).rejects.toThrow('still owns a process')
        attempts[0]!.reject(new Error('primary spawn rejected'))
        await rejected
        expect(attempts).toHaveLength(1)
        expect(host.listSessions()).toEqual([])
        expect(onData).not.toHaveBeenCalled()
        expect(onExit).not.toHaveBeenCalled()
        await expect(
          host.createOrAttach({
            sessionId: 'fallback',
            cols: 80,
            rows: 24,
            streamClient: { onData, onExit }
          })
        ).rejects.toThrow('still live')
        expect(attempts).toHaveLength(1)
        attempts[0]!.forceKill.mockImplementation(attempts[0]!.finish)
        return
      }
      attempts[0]!.reject(new Error('primary spawn rejected'))
      await waitFor(() => attempts.length === 2)
      expect(onData).not.toHaveBeenCalled()
      expect(onExit).not.toHaveBeenCalled()
      attempts[1]!.handle._simulateData('PUBLIC_FALLBACK')
      attempts[1]!.confirm()
      await pending
      expect(onData.mock.calls.map((call) => call[0]).join('')).toBe('PUBLIC_FALLBACK')
      expect(attempts[0]!.handle.forceKill).toHaveBeenCalledOnce()
    } finally {
      await host.dispose()
      Object.defineProperty(process, 'platform', platform)
    }
  }
)

function makeAttempt() {
  const handle = createMockSubprocess()
  let confirm!: () => void
  let reject!: (error: Error) => void
  const receipt = new Promise<void>((yes, no) => {
    confirm = yes
    reject = no
  })
  const exits = new Set<(event: { exitCode: number }) => void>()
  const finish = () => {
    handle._simulateExit(1)
    for (const listener of exits) {
      listener({ exitCode: 1 })
    }
  }
  const forceKill = vi.fn(finish)
  handle.forceKill = forceKill
  const process: BunPtyProcess = {
    pid: handle.pid,
    process: 'shell',
    cols: 80,
    rows: 24,
    handleFlowControl: false,
    write() {},
    resize() {},
    clear() {},
    pause() {},
    resume() {},
    kill: finish,
    destroy: finish,
    waitForSpawn: () => receipt,
    onData: () => ({ dispose() {} }),
    onExit(listener) {
      exits.add(listener)
      return { dispose: () => exits.delete(listener) }
    }
  }
  return { handle, process, confirm, reject, finish, forceKill }
}

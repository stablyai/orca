import { afterEach, expect, it, vi } from 'vitest'

const shell = vi.hoisted(() => {
  const events: { data?: (data: string) => void; exit?: () => void } = {}
  const write = vi.fn((data: string) => {
    if (data.startsWith('PS1=')) {
      queueMicrotask(() => events.data?.('@@ORCA-PTY-READY@@'))
    }
    if (data === 'exit\r') {
      queueMicrotask(() => events.exit?.())
    }
  })
  return { events, write }
})

vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: (listener: (data: string) => void) => {
      shell.events.data = listener
    },
    onExit: (listener: () => void) => {
      shell.events.exit = listener
    },
    write: shell.write,
    kill: vi.fn()
  })
}))

import { runZshPty } from './zsh-startup-hook-pty-harness'

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  shell.events.data = undefined
  shell.events.exit = undefined
})

it('waits through silent startup before answering compinit and setting the prompt', async () => {
  vi.useFakeTimers()
  const running = runZshPty({ env: {} })
  await vi.advanceTimersByTimeAsync(500)
  expect(shell.write).not.toHaveBeenCalled()

  shell.events.data?.('Ignore insecure directories and continue [y] or abort compinit [n]? ')
  expect(shell.write).toHaveBeenCalledExactlyOnceWith('y\r')
  shell.events.data?.('startup finished\r\nprompt% ')
  await vi.advanceTimersByTimeAsync(250)

  expect(await running).toMatchObject({ exitedBeforePrompt: false, values: {} })
  expect(shell.write.mock.calls).toEqual([['y\r'], ['PS1="$ORCA_PTY_SENTINEL"\r'], ['exit\r']])
})

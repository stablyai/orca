import { expect, it, vi } from 'vitest'
import { throwNoActiveSenderTerminal } from '../../orchestration/identity/terminal-identity'
import {
  dropForeignTerminalHandle,
  resolveFencedRuntimeSource,
  RuntimeSourceFence
} from './runtime-source-fence'

const windowsStamp = {
  sourceId: 'install-win',
  incarnation: 'runtime-win',
  profilePath: 'C:\\Users\\u\\AppData\\Roaming\\orca'
}

function paneEnv(): Record<string, string | undefined> {
  return {
    ORCA_TERMINAL_HANDLE: 'term_win',
    ORCA_RUNTIME_SOURCE_ID: windowsStamp.sourceId,
    ORCA_RUNTIME_SOURCE_INCARNATION: windowsStamp.incarnation,
    ORCA_RUNTIME_SOURCE_PROFILE_PATH: windowsStamp.profilePath
  }
}

it('does not fence a guest CLI to the Windows runtime that stamped its pane (#49580)', async () => {
  const linuxProfile = '/home/u/.config/orca'
  const expected = resolveFencedRuntimeSource(windowsStamp, linuxProfile, linuxProfile, 'linux')
  const probe = vi.fn()
  const fence = new RuntimeSourceFence(expected, probe)
  const metadata = {
    runtimeId: 'runtime-guest',
    pid: 1,
    transports: [],
    authToken: null,
    startedAt: 0
  }

  await expect(fence.check(metadata, 'terminal.list')).resolves.toBeUndefined()
  expect(probe).not.toHaveBeenCalled()
})

it('drops a Windows pane handle in a guest CLI so callers infer from cwd', () => {
  const env = paneEnv()
  dropForeignTerminalHandle(env, () => '/home/u/.config/orca', 'linux')

  expect(env.ORCA_TERMINAL_HANDLE).toBeUndefined()
  // A Codex caller must not be told its env policy removed the handle.
  vi.stubEnv('CODEX_THREAD_ID', 'thread-1')
  expect(() => throwNoActiveSenderTerminal()).toThrow(/opened by a different Orca/)
  vi.unstubAllEnvs()
})

it('keeps the handle when the profile path cannot be resolved', () => {
  const env = paneEnv()
  dropForeignTerminalHandle(env, () => {
    throw new Error('APPDATA is not set')
  })

  expect(env.ORCA_TERMINAL_HANDLE).toBe('term_win')
})

it('keeps the handle for a Windows CLI on the runtime that stamped its pane', () => {
  const env = paneEnv()
  dropForeignTerminalHandle(env, () => windowsStamp.profilePath, 'win32')

  expect(env.ORCA_TERMINAL_HANDLE).toBe('term_win')
})

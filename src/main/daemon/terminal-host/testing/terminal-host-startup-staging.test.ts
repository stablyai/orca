import '../../pty-subprocess/testing/mock-descendant-sweep'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from '../terminal-host'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'

let tempDir: string
let exitSubprocess: ((code: number) => void) | undefined

function mockSubprocess(shellPath: string): SubprocessHandle {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handle stubs only what session creation calls.
  return {
    pid: 1,
    shellPath,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: () => {},
    onExit: (callback: (code: number) => void) => {
      exitSubprocess = callback
    },
    dispose: vi.fn()
  } as SubprocessHandle
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'orca-daemon-staging-'))
  vi.stubEnv('TMPDIR', tempDir)
  exitSubprocess = undefined
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(tempDir, { recursive: true, force: true })
})

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('daemon startup command staging', () => {
  async function create(command: string, shellPath = '/bin/zsh') {
    const sub = mockSubprocess(shellPath)
    const host = new TerminalHost({ spawnSubprocess: () => sub })
    const result = await host.createOrAttach({
      sessionId: `s-${command.length}`,
      cols: 80,
      rows: 24,
      command,
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    return { sub, result }
  }

  it('deletes a script the shell never sourced when the session exits', async () => {
    await create(`claude '${'x'.repeat(600)}'`)
    const scriptPath = join(tempDir, readdirSync(tempDir)[0])
    exitSubprocess?.(0)
    expect(existsSync(scriptPath)).toBe(false)
  })
})

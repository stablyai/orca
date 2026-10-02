import { exec, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcess from 'node:child_process'
import {
  createFakeChild,
  createHandlers,
  requestContext,
  withPlatform
} from './agent-exec-handler-test-harness'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    exec: vi.fn(),
    spawn: vi.fn()
  }
})

const spawnMock = vi.mocked(spawn)
const execMock = vi.mocked(exec)

describe('AgentExecHandler Windows command spawning', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    execMock.mockReset()
  })

  it('resolves bare Windows agent commands to batch shims before spawning', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-agent-exec-'))
    const originalComSpec = process.env.ComSpec
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    try {
      await withPlatform('win32', async () => {
        const codexShim = join(tempDir, 'codex.cmd')
        writeFileSync(codexShim, '@echo off\r\n')
        const child = createFakeChild()
        spawnMock.mockReturnValue(child as never)
        const handlers = createHandlers()

        const pending = handlers.get('agent.execNonInteractive')!(
          {
            binary: 'codex',
            args: ['exec', '-s', 'read-only'],
            cwd: 'C:\\repo',
            stdin: 'PROMPT',
            timeoutMs: 5_000,
            env: { PATH: tempDir }
          },
          requestContext()
        )

        child.emit('close', 0)

        await expect(pending).resolves.toMatchObject({
          exitCode: 0,
          timedOut: false
        })
        expect(spawnMock).toHaveBeenCalledWith(
          'C:\\Windows\\System32\\cmd.exe',
          ['/d', '/s', '/c', `"${codexShim}" "exec" "-s" "read-only"`],
          {
            cwd: 'C:\\repo',
            env: expect.objectContaining({ PATH: tempDir }),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
          }
        )
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      if (originalComSpec === undefined) {
        delete process.env.ComSpec
      } else {
        process.env.ComSpec = originalComSpec
      }
    }
  })

  it('rejects unsafe args when routing Windows batch shims through cmd.exe', async () => {
    await withPlatform('win32', async () => {
      const handlers = createHandlers()

      const result = await handlers.get('agent.execNonInteractive')!(
        {
          binary: 'C:\\tools\\agent.cmd',
          args: ['hello & goodbye'],
          cwd: 'C:\\repo',
          stdin: null,
          timeoutMs: 5_000
        },
        requestContext()
      )

      expect(result).toEqual({
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        spawnError: 'UNSAFE_WINDOWS_BATCH_ARGUMENTS'
      })
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })

  it('hands a cmd.exe /d /s /c script over verbatim so inner quotes survive', async () => {
    await withPlatform('win32', async () => {
      const child = createFakeChild()
      spawnMock.mockReturnValue(child as never)
      const handlers = createHandlers()

      const pending = handlers.get('agent.execNonInteractive')!(
        {
          binary: 'cmd.exe',
          args: ['/d', '/s', '/c', 'prettier --write "C:\\repo\\a b.ts"'],
          cwd: 'C:\\repo',
          stdin: null,
          timeoutMs: 5_000
        },
        requestContext()
      )
      child.emit('close', 0)

      await expect(pending).resolves.toMatchObject({ exitCode: 0 })
      expect(spawnMock).toHaveBeenCalledWith(
        'cmd.exe',
        ['/d', '/s', '/c', '"prettier --write "C:\\repo\\a b.ts""'],
        expect.objectContaining({ windowsVerbatimArguments: true })
      )
    })
  })

  it.each([
    [
      'a quoted program followed by a quoted argument',
      '"C:\\Program Files\\fmt.exe" --write "C:\\a b.ts"'
    ],
    ['a lone quoted program path', '"C:\\Program Files\\fmt.exe"']
  ])('wraps %s exactly once, since callers send the bare command line', async (_label, script) => {
    await withPlatform('win32', async () => {
      const child = createFakeChild()
      spawnMock.mockReturnValue(child as never)
      const handlers = createHandlers()

      const pending = handlers.get('agent.execNonInteractive')!(
        {
          binary: 'cmd.exe',
          args: ['/d', '/s', '/c', script],
          cwd: 'C:\\repo',
          stdin: null,
          timeoutMs: 5_000
        },
        requestContext()
      )
      child.emit('close', 0)
      await pending

      // Why: /s strips one outer pair, so a script that starts and ends with a quote still needs its own pair.
      expect(spawnMock.mock.calls[0][1]).toEqual(['/d', '/s', '/c', `"${script}"`])
    })
  })

  it('leaves non-cmd binaries on the default argument quoting', async () => {
    await withPlatform('win32', async () => {
      const child = createFakeChild()
      spawnMock.mockReturnValue(child as never)
      const handlers = createHandlers()

      const pending = handlers.get('agent.execNonInteractive')!(
        {
          binary: 'node.exe',
          args: ['-e', 'console.log("x")'],
          cwd: 'C:\\repo',
          stdin: null,
          timeoutMs: 5_000
        },
        requestContext()
      )
      child.emit('close', 0)
      await pending

      expect(spawnMock.mock.calls[0][2]).not.toHaveProperty('windowsVerbatimArguments')
    })
  })
})

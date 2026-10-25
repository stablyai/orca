import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as OsModule from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { runProcess, runProcessSync, spawnProcess } from '@orca/process-host'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { getCursorHookResponse } from './hook-events'
import { CursorHookService } from './hook-service'

const { homeMock } = vi.hoisted(() => ({ homeMock: vi.fn<() => string>() }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof OsModule>()),
  homedir: homeMock
}))

const shells =
  process.platform === 'win32'
    ? []
    : ['sh', 'bash', 'zsh', 'dash', 'fish', 'nu'].flatMap((name) => {
        const path = runProcessSync({
          program: '/bin/sh',
          args: ['-c', 'command -v "$1"', 'shell-lookup', name]
        }).stdout.trim()
        return path
          ? [{ name, path, args: name === 'nu' ? ['--no-config-file', '-c'] : ['-c'] }]
          : []
      })

const configSchema = z.object({
  hooks: z.record(z.string(), z.array(z.object({ command: z.string() })))
})
const hostileLiteral = 'space \' " $ORCA_TEST_EXPAND $(touch injected) `touch backtick-injected` \\'
const payload = JSON.stringify({ text: `漢字😀${'x'.repeat(256 * 1024)}` })

describe.skipIf(process.platform === 'win32')('local Cursor hooks through login shells', () => {
  let fixture: string
  let scriptPath: string
  let command: string

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'orca-cursor-login-shell-'))
    const home = join(fixture, hostileLiteral)
    mkdirSync(home)
    homeMock.mockReturnValue(home)
    expect(new CursorHookService().install().state).toBe('installed')
    const config = configSchema.parse(
      JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8'))
    )
    const registered = config.hooks.preToolUse?.[0]?.command
    if (!registered) {
      throw new Error('Cursor preToolUse hook was not installed')
    }
    command = registered
    scriptPath = join(home, '.orca', 'agent-hooks', 'cursor-hook.sh')
  })

  afterEach(() => {
    vi.clearAllMocks()
    removeTreeSync(fixture)
  })

  function environment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ORCA_AGENT_HOOK_ENDPOINT: '',
      ORCA_AGENT_HOOK_PORT: '',
      ORCA_AGENT_HOOK_TOKEN: '',
      ORCA_PANE_KEY: '',
      ORCA_TEST_EXPAND: 'expanded',
      ORCA_TEST_LITERAL: hostileLiteral,
      HOME: fixture,
      XDG_CONFIG_HOME: join(fixture, 'config'),
      XDG_DATA_HOME: join(fixture, 'data')
    }
  }

  describe.each(shells)('$name', (shell) => {
    it('preserves the assigned response, inherited environment and UTF-8 stdin at a literal path', async () => {
      writeFileSync(
        scriptPath,
        '#!/bin/sh\nprintf "%s\\n" "$ORCA_CURSOR_HOOK_RESPONSE" "$ORCA_TEST_LITERAL"\ncommand -p cat\n'
      )
      const result = await runProcess({
        program: shell.path,
        args: [...shell.args, command],
        cwd: fixture,
        env: environment(),
        input: payload
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toBe(
        `${getCursorHookResponse('preToolUse')}\n${hostileLiteral}\n${payload}`
      )
      expect(result.stderr).toBe('')
      expect(existsSync(join(fixture, 'injected'))).toBe(false)
      expect(existsSync(join(fixture, 'backtick-injected'))).toBe(false)
    })

    it.each(['missing', 'nonexecutable', 'directory'])(
      'answers permission hooks when the managed script is %s',
      async (state) => {
        unlinkSync(scriptPath)
        if (state === 'nonexecutable') {
          writeFileSync(scriptPath, 'exit 99\n', { mode: 0o644 })
        }
        if (state === 'directory') {
          mkdirSync(scriptPath)
        }
        const result = await runProcess({
          program: shell.path,
          args: [...shell.args, command],
          cwd: fixture,
          env: environment(),
          input: payload
        })
        expect(result.code, result.stderr).toBe(0)
        expect(result.stdout).toBe(`${getCursorHookResponse('preToolUse')}\n`)
        expect(result.stderr).toBe('')
      }
    )

    it('returns the managed script exit code', async () => {
      writeFileSync(scriptPath, '#!/bin/sh\nexit 23\n')
      const result = await runProcess({
        program: shell.path,
        args: [...shell.args, command],
        cwd: fixture,
        env: environment()
      })
      expect(result.code, result.stderr).toBe(23)
      expect(result.stdout).toBe('')
    })

    it('drains a missing-script payload until EOF even with an empty PATH', async () => {
      unlinkSync(scriptPath)
      const child = spawnProcess({
        program: shell.path,
        args: [...shell.args, command],
        cwd: fixture,
        env: { ...environment(), PATH: '' }
      })
      let stdout = ''
      let stderr = ''
      let exited = false
      const stdinErrors: Error[] = []
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      child.stdin.on('error', (error) => stdinErrors.push(error))
      const closed = new Promise<number | null>((resolve) =>
        child.on('close', (code) => {
          exited = true
          resolve(code)
        })
      )
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
      try {
        await new Promise<void>((resolve, reject) =>
          child.stdin.write(payload, (error) => {
            if (error) {
              reject(error)
            } else {
              resolve()
            }
          })
        )
        expect(exited).toBe(false)
        child.stdin.end()
        expect(await closed, stderr).toBe(0)
        expect(stdinErrors).toEqual([])
        expect(stdout).toBe(`${getCursorHookResponse('preToolUse')}\n`)
        expect(stderr).toBe('')
      } finally {
        clearTimeout(timeout)
        child.kill('SIGKILL')
        await closed
      }
    })
  })
})

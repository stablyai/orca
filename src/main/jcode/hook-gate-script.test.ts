import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { runProcess } from '@orca/process-host'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))
vi.mock('os', async () => {
  // oxlint-disable-next-line typescript/consistent-type-imports -- vi.importActual needs the inline import() to type the real module
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: homedirMock }
})

import { JcodeHookService } from './hook-service'
import { getJcodeConfigPath, getJcodeManagedScriptPath, JCODE_HOOK_EVENTS } from './hook-settings'

/** Installs the managed hook into a throwaway home and returns the script path. */
function installManagedScript(): { scriptPath: string; cleanup: () => void } {
  const homeDir = mkdtempSync(join(tmpdir(), 'orca-jcode-gate-'))
  homedirMock.mockReturnValue(homeDir)
  vi.stubEnv('JCODE_HOME', join(homeDir, '.jcode'))
  new JcodeHookService().install()
  const scriptPath = getJcodeManagedScriptPath()
  return {
    scriptPath,
    cleanup: () => {
      vi.unstubAllEnvs()
      removeTreeSync(homeDir)
    }
  }
}

describe.runIf(process.platform !== 'win32')('jcode managed hook as jcode runs it', () => {
  it('drains the gate stdin before exiting on a missing Orca environment', () => {
    const { scriptPath, cleanup } = installManagedScript()
    try {
      // The claim is that this returns at all: a gate that exits without reading
      // leaves jcode blocked mid-write on an input larger than the pipe buffer, and
      // execFileSync would then raise ETIMEDOUT rather than complete.
      execFileSync('/bin/sh', [scriptPath], {
        input: JSON.stringify({ content: 'y'.repeat(512 * 1024) }),
        // No ORCA_PANE_KEY: the script exits early, but only after taking stdin.
        env: { ...process.env, JCODE_HOOK_EVENT: 'pre_tool', ORCA_PANE_KEY: '' },
        // Generous on purpose: the claim is "does not hang", not "is fast", and a
        // tight bound here is the same flake the dropped latency test had.
        timeout: 60_000,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } finally {
      cleanup()
    }
  })

  it('posts synchronously for observer events, which jcode never waits on', () => {
    const { scriptPath, cleanup } = installManagedScript()
    try {
      const script = readFileSync(scriptPath, 'utf8')
      const gateBranch = script.slice(script.indexOf('if [ "$JCODE_HOOK_EVENT" = pre_tool ]'))
      expect(gateBranch).toContain('orca_post_jcode_event >/dev/null 2>&1 &')
      // The observer path keeps the foreground call, so a slow POST cannot be lost
      // to a script that exited first.
      expect(gateBranch).toContain('orca_post_jcode_event >/dev/null 2>&1 || :')
      expect(script.trimEnd().endsWith('exit 0')).toBe(true)
    } finally {
      cleanup()
    }
  })
})

describe('the Windows managed hook', () => {
  // Why these run everywhere: Windows is the platform this PR could not exercise on
  // real hardware, so the generated script's shape is pinned from any host.
  afterEach(() => vi.restoreAllMocks())

  function windowsScript(): string {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { scriptPath, cleanup } = installManagedScript()
    try {
      return readFileSync(scriptPath, 'utf8')
    } finally {
      cleanup()
    }
  }

  it('drains the gate stdin, but only after the Orca environment check', () => {
    const script = windowsScript()
    const guardIndex = script.indexOf('if "%ORCA_PANE_KEY%"==""')
    const drainIndex = script.indexOf('if "%JCODE_HOOK_EVENT%"=="pre_tool"')
    expect(guardIndex).toBeGreaterThan(-1)
    expect(drainIndex).toBeGreaterThan(guardIndex)
    // Why this order is inverted from the POSIX script: outside an Orca pane the
    // caller abandons stdin instead of closing it, so a hook that reads it hangs
    // forever and strands a console window (#11549). Exiting early instead costs
    // only jcode's own 5s pre_tool timeout, which fails open.
    expect(script).toContain('more.com')
  })

  it('posts jcode\u2019s payload, which never reaches stdin on Windows', () => {
    const script = windowsScript()
    // Why: the shared builder reads `payload@-`, but the gate has already drained
    // stdin and observer hooks get a null one — so the payload has to come from the
    // env var via a temp file, or the server sees no event name and drops everything.
    expect(script).toContain('setlocal EnableDelayedExpansion')
    expect(script).toContain('echo(!JCODE_HOOK_PAYLOAD!')
    expect(script).toMatch(/<"%ORCA_JCODE_PAYLOAD_FILE%" .*curl\.exe/)
    expect(script).not.toContain(' | ')
    expect(script).toContain('hook_event_name=%JCODE_HOOK_EVENT%')
    expect(script).toContain('del "%ORCA_JCODE_PAYLOAD_FILE%"')
  })

  it('is a CRLF batch file that always exits 0', () => {
    const script = windowsScript()
    expect(script.startsWith('@echo off\r\n')).toBe(true)
    expect(script.includes('\r\n')).toBe(true)
    expect(script).toContain('exit /b 0')
    // Why: jcode parses the hook command shell-style but executes it directly, so
    // the file has to be runnable on its own.
    expect(script).not.toContain('#!/bin/sh')
  })

  it('refreshes an existing Windows pipeline hook without editing config', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const { scriptPath, cleanup } = installManagedScript()
    try {
      const script = readFileSync(scriptPath, 'utf8')
      const configPath = getJcodeConfigPath()
      const config = readFileSync(configPath, 'utf8')
      writeFileSync(
        scriptPath,
        script.replace('<"%ORCA_JCODE_PAYLOAD_FILE%"', 'type "%ORCA_JCODE_PAYLOAD_FILE%" |')
      )
      await new JcodeHookService().refreshManagedScripts()
      expect(readFileSync(scriptPath, 'utf8')).toBe(script)
      expect(readFileSync(configPath, 'utf8')).toBe(config)
    } finally {
      cleanup()
    }
  })
})

describe.runIf(process.platform === 'win32')('Windows jcode hook payload delivery', () => {
  it('delivers all six events and drains large gate input without a pipeline', async () => {
    const { scriptPath, cleanup } = installManagedScript()
    const posts: {
      path: string | undefined
      token: string | string[] | undefined
      form: URLSearchParams
    }[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        posts.push({
          path: request.url,
          token: request.headers['x-orca-agent-hook-token'],
          form: new URLSearchParams(body)
        })
        response.end('{}')
      })
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Expected a TCP listener')
      }
      for (const event of JCODE_HOOK_EVENTS) {
        const payload = JSON.stringify({ event, tool_input: 'quotes " & pipe | bang ! %PATH% < >' })
        const result = await runProcess({
          program: scriptPath,
          env: {
            ...process.env,
            ORCA_BACKGROUND_LAUNCH: '1',
            ORCA_AGENT_HOOK_ENDPOINT: '',
            ORCA_AGENT_HOOK_PORT: String(address.port),
            ORCA_AGENT_HOOK_TOKEN: 'jcode-delivery-token',
            ORCA_PANE_KEY: 'jcode:leaf',
            JCODE_HOOK_EVENT: event,
            JCODE_HOOK_SESSION_ID: 'jcode-session',
            JCODE_HOOK_CWD: dirname(scriptPath),
            JCODE_HOOK_PAYLOAD: payload
          },
          input: event === 'pre_tool' ? 'y'.repeat(512 * 1024) : '',
          timeoutMs: 10_000
        })
        expect(result).toMatchObject({ code: 0, stdout: '', stderr: '', timedOut: false })
        const post = posts.at(-1)
        expect(posts).toHaveLength(JCODE_HOOK_EVENTS.indexOf(event) + 1)
        expect(post?.path).toBe('/hook/jcode')
        expect(post?.token).toBe('jcode-delivery-token')
        expect(post?.form.get('payload')).toBe(`${payload}\r\n`)
        expect(post?.form.get('hook_event_name')).toBe(event)
        expect(post?.form.get('paneKey')).toBe('jcode:leaf')
        expect(post?.form.get('session_id')).toBe('jcode-session')
        expect(post?.form.get('cwd')).toBe(dirname(scriptPath))
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      cleanup()
    }
  }, 30_000)
})

describe.runIf(process.platform !== 'win32')('managed script shape', () => {
  it('writes an executable script jcode can exec directly', () => {
    const { scriptPath, cleanup } = installManagedScript()
    try {
      mkdirSync(dirname(scriptPath), { recursive: true })
      chmodSync(scriptPath, 0o755)
      const script = readFileSync(scriptPath, 'utf8')
      // Why: jcode parses the command shell-style but executes it directly, so the
      // file itself must carry the interpreter.
      expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    } finally {
      cleanup()
    }
  })
})

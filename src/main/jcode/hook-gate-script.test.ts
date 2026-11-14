import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { runProcess } from '@orca/process-host'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))
vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, homedir: homedirMock }
})

import { JcodeHookService } from './hook-service'
import { getJcodeManagedScriptPath, JCODE_HOOK_EVENTS } from './hook-settings'

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
      // Returning proves the gate drained input larger than the pipe buffer before exiting.
      execFileSync('/bin/sh', [scriptPath], {
        input: JSON.stringify({ content: 'y'.repeat(512 * 1024) }),
        // Outside Orca, POSIX must still drain stdin before exiting.
        env: { ...process.env, JCODE_HOOK_EVENT: 'pre_tool', ORCA_PANE_KEY: '' },
        // This checks completion, not latency; allow slow CI hosts.
        timeout: 60_000,
        stdio: ['pipe', 'pipe', 'pipe']
      })
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

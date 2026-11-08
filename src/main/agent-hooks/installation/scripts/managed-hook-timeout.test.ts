import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { runProcessSync } from '@orca/process-host'
import { buildPosixAgentHookPostCommand } from './hook-post-command'
import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return {
    ...actual,
    homedir: homedirMock.mockImplementation(actual.homedir)
  }
})
import '../../../codex/hooks/installation/hook-service'
import { CodexHookService } from '../../../codex/hooks/installation/codex-hook-service-implementation'
import { createAgentHookMemorySftp as createFakeSftp } from '../remote/testing/agent-hook-memory-sftp.test-fixture'

const REMOTE_HOME = '/home/dev'

describe('managed agent hook timeouts', () => {
  it.skipIf(process.platform === 'win32').each(['raw-json-v1', ''])(
    'scopes the C numeric locale to the custom curl command for transport %s',
    (transport) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'orca-custom-curl-locale-'))
      try {
        const curlPath = join(tmpDir, 'curl with spaces')
        const observed = join(tmpDir, 'curl-locale')
        const shellObserved = join(tmpDir, 'shell-locale')
        const payloadPath = join(tmpDir, 'custom-curl-payload')
        writeFileSync(
          curlPath,
          '#!/bin/sh\nprintf "%s|%s" "$LC_ALL" "$LC_NUMERIC" > "$ORCA_TEST_CURL_LOCALE"\ncat > "$ORCA_TEST_CURL_PAYLOAD"\n'
        )
        chmodSync(curlPath, 0o755)
        const payload = '{"prompt":"漢字 $HOME & quoted"}'
        const command = [
          'payload="$ORCA_TEST_PAYLOAD"',
          'curl_bin="$ORCA_TEST_CURL_BIN"',
          ...buildPosixAgentHookPostCommand('codex', { curlCommand: '"$curl_bin"' }),
          'printf "%s|%s" "$LC_ALL" "$LC_NUMERIC" > "$ORCA_TEST_SHELL_LOCALE"'
        ].join('\n')
        const result = runProcessSync({
          program: '/bin/sh',
          args: ['-c', command],
          env: {
            PATH: '/usr/bin:/bin',
            LC_ALL: 'de_DE.UTF-8',
            LC_NUMERIC: 'de_DE.UTF-8',
            ORCA_AGENT_HOOK_TRANSPORT: transport,
            ORCA_AGENT_HOOK_PORT: '1234',
            ORCA_AGENT_HOOK_TOKEN: 'token',
            ORCA_TEST_CURL_BIN: curlPath,
            ORCA_TEST_CURL_LOCALE: observed,
            ORCA_TEST_SHELL_LOCALE: shellObserved,
            ORCA_TEST_CURL_PAYLOAD: payloadPath,
            ORCA_TEST_PAYLOAD: payload
          },
          timeoutMs: 5000
        })
        expect(result.timedOut).toBe(false)
        expect(result.code, result.stderr.toString()).toBe(0)
        expect(existsSync(observed)).toBe(true)
        expect(readFileSync(observed, 'utf8')).toBe('|C')
        expect(readFileSync(shellObserved, 'utf8')).toBe('de_DE.UTF-8|de_DE.UTF-8')
        expect(readFileSync(payloadPath, 'utf8')).toBe(payload)
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    }
  )

  describe('dead-endpoint transport budget', () => {
    let tempDir: string | null = null
    let server: Server | null = null
    const openSockets: Socket[] = []

    afterEach(() => {
      for (const socket of openSockets.splice(0)) {
        socket.destroy()
      }
      if (server) {
        server.close()
        server = null
      }
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true })
        tempDir = null
      }
    })

    const hasPosixCurl =
      process.platform !== 'win32' &&
      spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).status === 0

    function runHookScript(scriptPath: string, port: number): Promise<{ status: number | null }> {
      return new Promise((resolve, reject) => {
        const child = spawn('sh', [scriptPath], {
          env: {
            ...process.env,
            ORCA_AGENT_HOOK_ENDPOINT: '',
            ORCA_AGENT_HOOK_PORT: String(port),
            ORCA_AGENT_HOOK_TOKEN: 'test-token',
            ORCA_PANE_KEY: 'pane-1',
            ORCA_TAB_ID: 'tab-1',
            ORCA_WORKTREE_ID: 'wt-1',
            CLAUDE_JOB_DIR: ''
          },
          stdio: ['pipe', 'ignore', 'ignore']
        })
        const timeout = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('hook script exceeded test timeout'))
        }, 10_000)
        child.on('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        child.on('close', (status) => {
          clearTimeout(timeout)
          resolve({ status })
        })
        child.stdin.end('{"hook_event_name":"Stop"}')
      })
    }

    // An accepted, unanswered connection exercises max-time after connect-timeout has already passed.
    it.skipIf(!hasPosixCurl)(
      'returns within budget when the local listener accepts but never responds',
      async () => {
        const { sftp, fs } = createFakeSftp()
        await new CodexHookService().installRemote(sftp, REMOTE_HOME)
        const wrapperBody = fs.files.get(`${REMOTE_HOME}/.orca/agent-hooks/codex-hook.sh`)!

        tempDir = mkdtempSync(join(tmpdir(), 'orca-hook-timeout-'))
        const scriptPath = join(tempDir, 'codex-hook.sh')
        writeFileSync(scriptPath, wrapperBody, 'utf8')
        chmodSync(scriptPath, 0o755)

        const stallingServer = createServer((socket) => {
          openSockets.push(socket)
        })
        server = stallingServer
        const port = await new Promise<number>((resolve) => {
          stallingServer.listen(0, '127.0.0.1', () => {
            const address = stallingServer.address()
            resolve(typeof address === 'object' && address ? address.port : 0)
          })
        })

        const startedAt = Date.now()
        const result = await runHookScript(scriptPath, port)
        const elapsedMs = Date.now() - startedAt

        // POST timeout must fail open.
        expect(result.status).toBe(0)
        expect(openSockets.length).toBeGreaterThan(0)
        expect(elapsedMs).toBeGreaterThanOrEqual(1_000)
        // Allow overhead beyond curl's 1.5-second cap.
        expect(elapsedMs).toBeLessThan(6_000)
      }
    )
  })
})

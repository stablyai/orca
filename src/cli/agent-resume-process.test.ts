import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { z } from 'zod'

// Two real CLI cold starts need a subprocess budget on slower Windows and CI hosts.
it('real CLI processes select a recorded pane or conversation without launching an agent', async () => {
  const manifest = createRequire(resolve('package.json')).resolve('bun/package.json')
  const { bin } = z
    .object({ bin: z.object({ bun: z.string() }) })
    .parse(JSON.parse(readFileSync(manifest, 'utf8')))
  const root = mkdtempSync(join(tmpdir(), 'orca-resume-process-'))
  const endpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\resume-${randomUUID()}` : join(root, 'rpc')
  const paneKey = 'original-tab:11111111-1111-4111-8111-111111111111'
  const server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (!buffer.includes('\n')) {
        return
      }
      const request = z
        .object({
          id: z.string(),
          method: z.string(),
          params: z.record(z.string(), z.unknown()).default({})
        })
        .parse(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))))
      const valid =
        request.method === 'worktree.show' ||
        (request.method === 'agent.resume' &&
          request.params.worktree === 'id:wt-fixture' &&
          (request.params.paneKey === paneKey ||
            (request.params.agent === 'codex' && request.params.sessionId === 'old-conversation')))
      socket.end(
        `${JSON.stringify(
          valid
            ? {
                id: request.id,
                ok: true,
                result:
                  request.method === 'worktree.show'
                    ? { worktree: { id: 'wt-fixture', lineage: null } }
                    : {
                        worktreeId: 'wt-fixture',
                        paneKey,
                        agent: 'codex',
                        providerSession: { key: 'session_id', id: 'old-conversation' },
                        handle: 'term_original',
                        ptyId: 'resumed-pty',
                        disposition: 'resumed'
                      },
                _meta: { runtimeId: 'fixture-host' }
              }
            : {
                id: request.id,
                ok: false,
                error: { code: 'unexpected_request', message: `Unexpected ${request.method}` },
                _meta: { runtimeId: 'fixture-host' }
              }
        )}\n`
      )
    })
  })
  try {
    await new Promise<void>((ready) => server.listen(endpoint, ready))
    writeFileSync(
      join(root, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'fixture-host',
        pid: process.pid,
        startedAt: 1,
        authToken: 'fixture-token',
        transports: [{ kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint }]
      })
    )
    const env = {
      ...Object.fromEntries(
        'HOME USERPROFILE APPDATA LOCALAPPDATA XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME ORCA_E2E_HOME_DIR ORCA_E2E_USER_DATA_DIR ORCA_USER_DATA_PATH TEMP TMP TMPDIR'
          .split(' ')
          .map((key) => [key, root])
      ),
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec
    }
    for (const target of [
      ['--pane', paneKey],
      ['--agent', 'codex', '--session', 'old-conversation']
    ]) {
      const result = await runProcess({
        program: join(dirname(manifest), bin.bun),
        args: [
          resolve('src/cli/index.ts'),
          'agent',
          'resume',
          '--worktree',
          'id:wt-fixture',
          ...target,
          '--json'
        ],
        cwd: root,
        env,
        timeoutMs: 15_000
      })
      expect(result.code, result.stderr + result.stdout).toBe(0)
      expect(JSON.parse(result.stdout).result).toEqual({
        worktreeId: 'wt-fixture',
        paneKey,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'old-conversation' },
        handle: 'term_original',
        ptyId: 'resumed-pty',
        disposition: 'resumed'
      })
    }
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

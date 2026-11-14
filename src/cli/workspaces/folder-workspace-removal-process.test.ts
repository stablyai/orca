import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { z } from 'zod'
import {
  FOLDER_WORKSPACE_UNIQUE_ID_MUTATION_RUNTIME_CAPABILITY,
  PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY
} from '../../shared/worktree-runtime-capabilities'

// Real CLI processes share this budget, including their runtime startup.
it('real CLI folder removal preserves explicit archive approval and refuses unsupported hosts', async () => {
  const manifest = createRequire(resolve('package.json')).resolve('bun/package.json')
  const { bin } = z
    .object({ bin: z.object({ bun: z.string() }) })
    .parse(JSON.parse(readFileSync(manifest, 'utf8')))
  const root = mkdtempSync(join(tmpdir(), 'orca-group-remove-process-'))
  const endpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\group-remove-${randomUUID()}` : join(root, 'rpc')
  const removals: Record<string, unknown>[] = []
  let supportsHooks = true
  const archiveHookOverride = {
    worktreePath: '/fixture/group-root',
    outcome: 'exited',
    exitCode: 7,
    output: 'fixture-archive-output-seven',
    overridden: true
  }
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
      if (request.method === 'folderWorkspace.delete') {
        removals.push(request.params)
      }
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result:
            request.method === 'status.get'
              ? {
                  capabilities: [
                    FOLDER_WORKSPACE_UNIQUE_ID_MUTATION_RUNTIME_CAPABILITY,
                    ...(supportsHooks ? [PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY] : [])
                  ]
                }
              : {
                  deleted: true,
                  ...(request.params.allowFailedArchiveHook ? { archiveHookOverride } : {})
                },
          _meta: { runtimeId: 'group-host' }
        })}\n`
      )
    })
  })
  try {
    await new Promise<void>((ready) => server.listen(endpoint, ready))
    writeFileSync(
      join(root, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'group-host',
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
      CODEX_HOME: join(root, 'codex'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec
    }
    const run = (flags: string[], json = true) =>
      runProcess({
        program: join(dirname(manifest), bin.bun),
        args: [
          resolve('src/cli/index.ts'),
          'worktree',
          'rm',
          '--worktree',
          'folder:task-a',
          ...(json ? ['--json'] : []),
          ...flags
        ],
        cwd: root,
        env,
        timeoutMs: 15_000
      })
    for (const flags of [['--run-hooks'], ['--run-hooks', '--allow-failed-archive-hook']]) {
      const response = await run(flags)
      expect(response.code, response.stdout + response.stderr).toBe(0)
      expect(JSON.parse(response.stdout)).toMatchObject({ ok: true, result: { removed: true } })
      expect(removals.at(-1)).toEqual({
        folderWorkspaceId: 'task-a',
        requireUniqueId: true,
        runHooks: true,
        allowFailedArchiveHook: flags.includes('--allow-failed-archive-hook')
      })
    }
    const waived = await run(['--run-hooks', '--allow-failed-archive-hook'], false)
    expect(waived.code, waived.stdout + waived.stderr).toBe(0)
    expect(waived.stderr).toContain('fixture-archive-output-seven')
    const before = removals.length
    supportsHooks = false
    for (const flags of [['--run-hooks'], ['--run-hooks', '--allow-failed-archive-hook']]) {
      const response = await run(flags)
      expect(response.code).toBe(1)
      expect(JSON.parse(response.stdout)).toMatchObject({
        ok: false,
        error: { code: 'incompatible_runtime' }
      })
    }
    for (const flags of [['--delete-branch'], ['--allow-failed-archive-hook']]) {
      const response = await run(flags)
      expect(response.code).toBe(1)
      expect(JSON.parse(response.stdout)).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
    expect(removals).toHaveLength(before)
    const response = await run([])
    expect(response.code, response.stdout + response.stderr).toBe(0)
    expect(removals.at(-1)).toEqual({ folderWorkspaceId: 'task-a', requireUniqueId: true })
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

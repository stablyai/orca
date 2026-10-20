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
  AGENT_LAUNCH_RUNTIME_CAPABILITIES,
  AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY
} from '../shared/agent-launch-runtime-capability'
import { agentLaunchFixture } from './agent-launch-test-fixtures'

it('real CLI processes carry surface choices and refuse invalid or unsupported picks before mutation', async () => {
  const manifest = createRequire(resolve('package.json')).resolve('bun/package.json')
  const { bin } = z
    .object({ bin: z.object({ bun: z.string() }) })
    .parse(JSON.parse(readFileSync(manifest, 'utf8')))
  const program = join(dirname(manifest), bin.bun)
  const root = mkdtempSync(join(tmpdir(), 'orca-launch-process-'))
  const endpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\launch-${randomUUID()}` : join(root, 'rpc')
  const requests: { method: string; params: Record<string, unknown> }[] = []
  let capabilities: readonly string[] = AGENT_LAUNCH_RUNTIME_CAPABILITIES
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
          authToken: z.literal('fixture-token'),
          params: z.record(z.string(), z.unknown()).default({})
        })
        .parse(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))))
      requests.push(request)
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result:
            request.method === 'status.get'
              ? { capabilities }
              : request.method === 'worktree.show'
                ? { worktree: { id: 'wt-fixture', lineage: null } }
                : agentLaunchFixture('wt-fixture').result,
          _meta: { runtimeId: 'fixture-host' }
        })}\n`
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
      CODEX_HOME: join(root, 'codex'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec
    }
    const mutate = () =>
      requests.filter(
        ({ method }) => method.startsWith('agent.launch') || method === 'worktree.create'
      )
    for (const command of [
      ['agent', 'launch', '--worktree', 'id:wt-fixture'],
      ['worktree', 'create', '--repo', 'id:repo-fixture', '--name', 'task', '--no-parent']
    ]) {
      const run = (flags: string[]) =>
        runProcess({
          program,
          args: [resolve('src/cli/index.ts'), ...command, '--agent', 'claude', '--json', ...flags],
          cwd: root,
          env,
          timeoutMs: 15_000
        })
      for (const surface of ['chat', 'terminal']) {
        const response = await run(['--surface', surface])
        expect(response.code, response.stderr + response.stdout).toBe(0)
        expect(mutate().at(-1)).toMatchObject({
          method: 'agent.launchReplay',
          params: {
            surface,
            agent: 'claude',
            launchSource: 'cli',
            presentation: 'background',
            target:
              command[0] === 'agent'
                ? { kind: 'existing', worktree: 'id:wt-fixture' }
                : { kind: 'create-worktree', create: { repo: 'id:repo-fixture', name: 'task' } }
          }
        })
      }
      const beforeInvalid = requests.length
      for (const flags of [['--surface='], ['--surface'], ['--surface', 'invalid']]) {
        const response = await run(flags)
        expect(response.code).toBe(1)
        expect(response.stdout).toContain('invalid_argument')
      }
      expect(requests).toHaveLength(beforeInvalid)
      const beforeUnsupported = mutate().length
      for (const oldCapabilities of [
        [],
        AGENT_LAUNCH_RUNTIME_CAPABILITIES.filter(
          (capability) => capability !== AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY
        )
      ]) {
        capabilities = oldCapabilities
        const response = await run(['--surface', 'chat'])
        expect(response.code).toBe(1)
        expect(response.stdout).toContain('incompatible_runtime')
      }
      expect(mutate()).toHaveLength(beforeUnsupported)
      capabilities = AGENT_LAUNCH_RUNTIME_CAPABILITIES
    }
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

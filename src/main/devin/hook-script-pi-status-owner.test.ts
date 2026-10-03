import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { parseFormEncodedBody } from '../../shared/agent-hook-listener/request-body'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return { ...actual, homedir: homedirMock }
})

import { DevinHookService } from './hook-service'
import { createAgentHookMemorySftp } from '../agent-hooks/agent-hook-memory-sftp.test-fixture'

type HookRun = { exitCode: number | null; posts: string[]; bodies: string[]; stdinErrors: Error[] }
type HookLaunch = { command: string; args: string[] }

// Why large: the skip must still drain stdin, or Devin sees a broken pipe mid-write (#8110).
const PERMISSION_REQUEST = JSON.stringify({
  hook_event_name: 'PermissionRequest',
  tool_name: 'exec',
  tool_input: { command: `ls -la ${'x'.repeat(256 * 1024)}` }
})

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    removeTreeSync(dir)
  }
  vi.unstubAllEnvs()
})

async function writePosixScript(): Promise<string> {
  const memory = createAgentHookMemorySftp()
  expect((await new DevinHookService().installRemote(memory.sftp, '/home/dev')).state).toBe(
    'installed'
  )
  const script = memory.fs.files.get('/home/dev/.orca/agent-hooks/devin-hook.sh')
  expect(script).toBeDefined()
  const path = join(tempDir('orca-devin-hook-'), 'devin-hook.sh')
  writeFileSync(path, script!)
  return path
}

async function runPosixHook(env: NodeJS.ProcessEnv): Promise<HookRun> {
  return runHook({ command: '/bin/sh', args: [await writePosixScript()] }, env)
}

async function runHook(launch: HookLaunch, env: NodeJS.ProcessEnv): Promise<HookRun> {
  const posts: string[] = []
  const bodies: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      posts.push(request.url ?? '')
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(204).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Could not resolve Devin hook test listener port')
  }
  try {
    return await new Promise<HookRun>((resolve, reject) => {
      // Why strip ORCA_*: a test run inside Pi inherits Pi's own owner PID and pane env.
      const base = Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
      const child = spawn(launch.command, launch.args, {
        env: {
          ...Object.fromEntries(base),
          ORCA_AGENT_HOOK_PORT: String(address.port),
          ORCA_AGENT_HOOK_TOKEN: 'test-token',
          ORCA_PANE_KEY: 'tab-1:00000000-0000-4000-8000-000000000001',
          ...env
        },
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true
      })
      const stdinErrors: Error[] = []
      child.stdin.on('error', (error) => stdinErrors.push(error))
      child.once('error', reject)
      child.once('close', (exitCode) => resolve({ exitCode, posts, bodies, stdinErrors }))
      child.stdin.end(PERMISSION_REQUEST)
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe.skipIf(process.platform === 'win32')('Devin hook under a Pi status owner (#22011)', () => {
  it('posts when no Pi process owns the pane', async () => {
    const run = await runPosixHook({})
    expect(run.exitCode).toBe(0)
    expect(run.posts).toEqual(['/hook/devin'])
  })

  it.each(['ORCA_PI_STATUS_OWNED', 'ORCA_PRIME_AGENT_STATUS_OWNED'])(
    'drains stdin and skips the post while the %s owner is alive',
    async (key) => {
      const run = await runPosixHook({ [key]: String(process.pid) })
      expect(run.exitCode).toBe(0)
      expect(run.stdinErrors).toEqual([])
      expect(run.posts).toEqual([])
    }
  )

  it('posts when the recorded owner has exited', async () => {
    const exited = spawnSync('/bin/sh', ['-c', 'exit 0']).pid
    const run = await runPosixHook({ ORCA_PI_STATUS_OWNED: String(exited) })
    expect(run.posts).toEqual(['/hook/devin'])
  })

  // Why: `kill -0 0`, `00` and `-1` probe whole process groups and would always succeed.
  it.each(['0', '00', '-1', 'not-a-pid', ''])('ignores a malformed owner %j', async (value) => {
    const run = await runPosixHook({ ORCA_PI_STATUS_OWNED: value })
    expect(run.posts).toEqual(['/hook/devin'])
  })

  // Why: a spooled record would replay onto Pi's row once the hook server is back.
  it.each([
    { owner: 'no owner', env: {}, spooled: true },
    { owner: 'a live owner', env: { ORCA_PI_STATUS_OWNED: String(process.pid) }, spooled: false }
  ])('spools an undeliverable event only without an owner ($owner)', async ({ env, spooled }) => {
    const dir = tempDir('orca-devin-hook-endpoint-')
    const endpoint = join(dir, 'endpoint.env')
    writeFileSync(endpoint, '')
    // Why empty port: takes the missing-env branch, which spools instead of posting.
    await runPosixHook({ ...env, ORCA_AGENT_HOOK_ENDPOINT: endpoint, ORCA_AGENT_HOOK_PORT: '' })
    expect(existsSync(join(dir, 'spool'))).toBe(spooled)
  })
})

/** Feeds a real post through the listener the hook server runs; null means the event was dropped. */
function listenerAccepts(body: string): boolean {
  const record = parseFormEncodedBody(body)
  return normalizeHookPayload(createHookListenerState(), 'devin', record, record.env ?? '') !== null
}

describe.skipIf(process.platform !== 'win32')('Windows Devin hook run under a Pi owner', () => {
  it('lets the listener drop the event only while the recorded owner lives', async () => {
    const home = tempDir('orca-devin-win-live-')
    homedirMock.mockReturnValue(home)
    vi.stubEnv('APPDATA', join(home, 'AppData', 'Roaming'))
    expect(new DevinHookService().install().state).toBe('installed')
    const script = join(home, '.orca', 'agent-hooks', 'devin-hook.cmd')
    const launch = { command: 'cmd.exe', args: ['/d', '/c', script] }
    const exited = spawnSync('cmd.exe', ['/d', '/c', 'exit 0'], { windowsHide: true }).pid

    const unowned = await runHook(launch, {})
    expect(unowned.exitCode).toBe(0)
    expect(unowned.posts).toEqual(['/hook/devin'])
    expect(listenerAccepts(unowned.bodies[0])).toBe(true)
    for (const key of ['ORCA_PI_STATUS_OWNED', 'ORCA_PRIME_AGENT_STATUS_OWNED']) {
      const live = await runHook(launch, { [key]: String(process.pid) })
      expect(live.exitCode, key).toBe(0)
      expect(live.stdinErrors, key).toEqual([])
      expect(parseFormEncodedBody(live.bodies[0])[key], key).toBe(String(process.pid))
      expect(listenerAccepts(live.bodies[0]), key).toBe(false)
      // Why: a descendant that outlives Pi keeps the marker; its events must reach the pane again.
      const stale = await runHook(launch, { [key]: String(exited) })
      expect(listenerAccepts(stale.bodies[0]), key).toBe(true)
    }
    // Why: five cmd.exe launches plus a real install can overrun the default under load.
  }, 90_000)
})

describe('Windows Devin hook under a Pi status owner (#22011)', () => {
  it('names the owner in the post instead of skipping it', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const home = tempDir('orca-devin-win-')
    homedirMock.mockReturnValue(home)
    vi.stubEnv('APPDATA', join(home, 'AppData', 'Roaming'))
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      expect(new DevinHookService().install().state).toBe('installed')
      const script = readFileSync(join(home, '.orca', 'agent-hooks', 'devin-hook.cmd'), 'utf8')
      const post = script.indexOf('/hook/devin')
      const payload = script.indexOf('payload@-')
      for (const key of ['ORCA_PI_STATUS_OWNED', 'ORCA_PRIME_AGENT_STATUS_OWNED']) {
        const field = script.indexOf(`--data-urlencode "${key}=%${key}%" ^`)
        expect(field, key).toBeGreaterThan(post)
        expect(field, key).toBeLessThan(payload)
        // Why: a skip in cmd cannot see whether the owner is alive, so it would outlive Pi.
        expect(script, key).not.toMatch(new RegExp(`%${key}%.*goto`))
      }
    } finally {
      Object.defineProperty(process, 'platform', platform)
      vi.unstubAllEnvs()
    }
  })
})

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { runProcess, spawnProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { DATA_ACCOUNT_RUNTIME_CAPABILITY } from '../shared/account-runtime-capabilities'

const eventSchema = z.object({
  name: z.string(),
  args: z.array(z.string()),
  dataHome: z.string(),
  configHome: z.string(),
  database: z.string(),
  kind: z.enum(['probe', 'login', 'stopped', 'survived', 'owned', 'escaped', 'stopping']),
  pid: z.number(),
  started: z.string(),
  dataHomeExists: z.boolean()
})

async function accountFixture() {
  const manifest = createRequire(resolve('package.json')).resolve('bun/package.json')
  const { bin } = z
    .object({ bin: z.object({ bun: z.string() }) })
    .parse(JSON.parse(readFileSync(manifest, 'utf8')))
  const program = join(dirname(manifest), bin.bun)
  const root = mkdtempSync(join(tmpdir(), 'orca-account-process-'))
  const tools = join(root, 'bin')
  mkdirSync(tools)
  const eventsPath = join(root, 'events.jsonl')
  const modePath = join(root, 'mode.json')
  const endpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\account-${randomUUID()}` : join(root, 'rpc')
  const requests: { method: string; params: Record<string, unknown> }[] = []
  const events = () =>
    existsSync(eventsPath)
      ? readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => eventSchema.parse(JSON.parse(line)))
      : []
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
      requests.push(request)
      if (request.method === 'accounts.addDataFromHome') {
        const source = z.string().parse(request.params.sourceDataHome)
        expect(readFileSync(join(source, 'fixture-login'), 'utf8')).toBe('completed')
      }
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result:
            request.method === 'status.get'
              ? { capabilities: [DATA_ACCOUNT_RUNTIME_CAPABILITY] }
              : { accounts: [], activeAccountId: null },
          _meta: { runtimeId: 'fixture-host' }
        })}\n`
      )
    })
  })
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
  for (const name of ['opencode2', 'opencode']) {
    const script = join(tools, `${name}.cjs`)
    writeFileSync(
      script,
      `const fs = require('node:fs');
const cp = require('node:child_process');
const mode = JSON.parse(fs.readFileSync(${JSON.stringify(modePath)}, 'utf8'));
const name = ${JSON.stringify(name)};
const args = process.argv.slice(2);
const probe = args.includes('--help');
fs.mkdirSync(process.env.XDG_DATA_HOME, {recursive:true});
const record = kind => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({
  name, args, kind, pid:process.pid,
  started:process.platform === 'win32' ? '' : cp.execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {encoding:'utf8'}).trim(),
  dataHome:process.env.XDG_DATA_HOME,
  configHome:process.env.XDG_CONFIG_HOME, database:process.env.OPENCODE_DB,
  dataHomeExists:fs.existsSync(process.env.XDG_DATA_HOME)
}) + '\\n');
if (args[0] === 'owned' || args[0] === 'escaped') {
  record(args[0]);
  process.on('SIGTERM', () => {});
  // Adversarial output arrives after the execution deadline; it must never grant support.
  if (args[0] === 'escaped') setTimeout(() => console.log('--standalone'), 10500);
  setTimeout(() => process.exit(0), 60000);
  return;
}
record(probe ? 'probe' : 'login');
if (probe && name === 'opencode2' && mode.lifecycle) {
  if (mode.lifecycle !== 'natural') cp.spawn(process.execPath, [__filename, 'owned'], {stdio:['ignore', 1, 2]});
  cp.spawn(process.execPath, [__filename, 'escaped'], {stdio:['ignore', 1, 2], detached:true});
  process.on('SIGTERM', () => {record('stopping'); process.exit(0)});
  if (mode.lifecycle === 'natural') {
    console.log('usage: auth login');
    setTimeout(() => process.stderr.write('--standalone  private server\\n', () => process.exit(0)), 200);
  } else setTimeout(() => process.exit(0), 60000);
} else if (probe && mode.hold) {
  process.on('SIGTERM', () => {record('stopped'); process.exit(0)});
  setTimeout(() => {record('survived'); process.exit(0)}, 3000);
} else if (probe) {
  console.log(mode.supported === name || mode.nonzero === name ? '--standalone' : '--pure');
  process.exit(mode.nonzero === name ? 1 : 0);
} else {
  console.log('interactive login output');
  if (!mode.loginExit) fs.writeFileSync(require('node:path').join(process.env.XDG_DATA_HOME, 'fixture-login'), 'completed');
  process.exit(mode.loginExit || 0);
}
`
    )
    writeFileSync(
      join(tools, process.platform === 'win32' ? `${name}.cmd` : name),
      process.platform === 'win32'
        ? `@"${process.execPath}" "%~dp0\\${name}.cjs" %*\r\n`
        : `#!${process.execPath}\nrequire(${JSON.stringify(script)})\n`,
      { mode: 0o700 }
    )
  }
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
    PATH: tools + delimiter + dirname(process.execPath),
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec
  }
  const spec = {
    program,
    args: [
      resolve('src/cli/index.ts'),
      'account',
      'add',
      '--agent',
      'opencode',
      '--integration',
      'opencode-go',
      '--label',
      'CLI fixture',
      '--json'
    ],
    cwd: root,
    env,
    timeoutMs: 15_000
  }
  return {
    spec,
    events,
    requests,
    mode(value: Record<string, unknown>) {
      writeFileSync(modePath, JSON.stringify(value))
      writeFileSync(eventsPath, '')
      requests.length = 0
    },
    async close() {
      if (process.platform !== 'win32') {
        for (const event of events().toReversed()) {
          if (fixtureProcessAlive(event)) {
            process.kill(event.pid, 'SIGKILL')
          }
        }
      }
      await new Promise<void>((done) => server.close(() => done()))
      rmSync(root, { recursive: true, force: true })
    }
  }
}

// Four serial real CLI subprocesses each have a 15-second deadline.
it('real account-add CLI probes, selects, logs in, hands off capture and cleans up; failures never enroll', async () => {
  const fixture = await accountFixture()
  try {
    for (const mode of [
      { supported: 'opencode2' },
      { supported: 'opencode', nonzero: 'opencode2' },
      { supported: 'neither' },
      { supported: 'opencode2', loginExit: 7 }
    ]) {
      fixture.mode(mode)
      const result = await runProcess(fixture.spec)
      const success = mode.supported !== 'neither' && !mode.loginExit
      expect(result.code, result.stdout + result.stderr).toBe(success ? 0 : 1)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: success })
      const events = fixture.events()
      expect(events[0]).toMatchObject({ name: 'opencode2', args: ['auth', 'login', '--help'] })
      const login = events.find(({ kind }) => kind === 'login')
      if (mode.supported === 'neither') {
        expect(login).toBeUndefined()
        expect(JSON.parse(result.stdout).error.message).toMatch(
          /npm install --prefix [^`\r\n]+ @opencode\/cli/
        )
      } else {
        expect(login).toMatchObject({
          name: mode.supported,
          args: ['auth', 'login', 'opencode-go', '--standalone'],
          database: 'opencode.db'
        })
        expect(result.stderr).toContain('interactive login output')
      }
      expect(events.every(({ dataHome, configHome }) => dataHome !== configHome)).toBe(true)
      expect(events.every(({ dataHome }) => !existsSync(dirname(dataHome)))).toBe(true)
      expect(fixture.requests.map(({ method }) => method)).toEqual(
        success ? ['status.get', 'accounts.addDataFromHome'] : ['status.get']
      )
      if (success) {
        expect(fixture.requests.at(-1)?.params).toEqual({
          provider: 'opencode',
          sourceDataHome: login?.dataHome,
          label: 'CLI fixture'
        })
        expect(events.every(({ dataHome }) => dataHome === login?.dataHome)).toBe(true)
      }
    }
  } finally {
    await fixture.close()
  }
}, 60_000)

it.skipIf(process.platform === 'win32')(
  'SIGTERM during the real CLI help probe stops it before cleanup without fallback or capture',
  async () => {
    const fixture = await accountFixture()
    fixture.mode({ hold: true })
    const child = spawnProcess(fixture.spec)
    const exited = once(child, 'close')
    child.stdout?.resume()
    child.stderr?.resume()
    try {
      await expect.poll(() => fixture.events().length, { timeout: 10_000 }).toBe(1)
      child.kill('SIGTERM')
      expect(await exited).toEqual([143, null])
      expect(fixture.events().map(({ kind, dataHomeExists }) => [kind, dataHomeExists])).toEqual([
        ['probe', true],
        ['stopped', true]
      ])
      expect(fixture.requests.map(({ method }) => method)).toEqual(['status.get'])
      expect(fixture.events().every(({ dataHome }) => !existsSync(dirname(dataHome)))).toBe(true)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await exited
      }
      await fixture.close()
    }
  },
  // Allows the 10-second probe-start wait plus child termination and fixture cleanup.
  20_000
)

// Identity checks make fixture cleanup safe even after a wrapper or descendant has exited.
function fixtureProcessAlive(event: { pid: number; started: string }): boolean {
  if (!Number.isInteger(event.pid) || event.pid <= 0 || !event.started) {
    throw new Error('Missing owned fixture process identity')
  }
  try {
    const started = execFileSync('/bin/ps', ['-p', String(event.pid), '-o', 'lstart='], {
      encoding: 'utf8'
    }).trim()
    const state = execFileSync('/bin/ps', ['-p', String(event.pid), '-o', 'state='], {
      encoding: 'utf8'
    }).trim()
    return started === event.started && !state.startsWith('Z')
  } catch {
    return false
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`CLI did not exit within ${ms}ms`)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

it.skipIf(process.platform === 'win32').each(['timeout', 'natural', 'cancel'])(
  'real CLI %s probe settles with held pipes, owned descendants and private cleanup',
  async (lifecycle) => {
    const fixture = await accountFixture()
    fixture.mode({ lifecycle, supported: lifecycle === 'natural' ? 'opencode2' : 'opencode' })
    const child = spawnProcess(fixture.spec)
    const exited = once(child, 'close')
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    try {
      await expect
        .poll(() => fixture.events().some(({ kind }) => kind === 'escaped'), { timeout: 10_000 })
        .toBe(true)
      const escaped = fixture.events().find(({ kind }) => kind === 'escaped')!
      if (lifecycle === 'cancel') {
        await expect
          .poll(() => fixture.events().some(({ kind }) => kind === 'stopping'), { timeout: 15_000 })
          .toBe(true)
        child.kill('SIGTERM')
      }
      // Real 10s execution + 5s graceful stop + 2s group verification, plus startup/drain slack.
      expect(
        await within(exited, lifecycle === 'natural' ? 5_000 : 24_000),
        stdout + stderr
      ).toEqual([lifecycle === 'cancel' ? 143 : 0, null])
      expect(fixtureProcessAlive(escaped)).toBe(true)
      const events = fixture.events()
      const owned = events.find(({ kind }) => kind === 'owned')
      if (lifecycle !== 'natural') {
        expect(owned).toBeDefined()
        if (owned) {
          expect(fixtureProcessAlive(owned)).toBe(false)
        }
      }
      if (lifecycle === 'cancel') {
        expect(events.find(({ kind }) => kind === 'stopping')?.dataHomeExists).toBe(true)
      }
      expect(events.every(({ dataHome }) => !existsSync(dirname(dataHome)))).toBe(true)
      expect(events.filter(({ kind }) => kind === 'probe').map(({ name }) => name)).toEqual(
        lifecycle === 'timeout' ? ['opencode2', 'opencode'] : ['opencode2']
      )
      expect(events.filter(({ kind }) => kind === 'login').map(({ name }) => name)).toEqual(
        lifecycle === 'cancel' ? [] : [lifecycle === 'natural' ? 'opencode2' : 'opencode']
      )
      expect(fixture.requests.map(({ method }) => method)).toEqual(
        lifecycle === 'cancel' ? ['status.get'] : ['status.get', 'accounts.addDataFromHome']
      )
      if (lifecycle !== 'cancel') {
        expect(JSON.parse(stdout)).toMatchObject({ ok: true })
      }
    } finally {
      // Only recorded fixture identities and this test's own CLI handle may be stopped.
      await fixture.close()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await within(exited, 10_000)
      }
    }
  },
  // Includes startup observation, the real deadline, bounded termination and failure cleanup.
  50_000
)

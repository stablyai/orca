import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { spawnProcess } from '@orca/process-host'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JSONC_PARSER_ESM_ALIAS } from '../../../config/build-plugins/jsonc-parser-esm'
import { isPlainObject } from '../agent-hooks/hooks-json-read'
import { readManagedHookProcessIdentity } from '../agent-hooks/managed-hook-owner-identity'
import { ownerFileName } from '../agent-hooks/managed-hook-lock-records'
import { readWindowsProcessCreationTime } from '../windows/windows-process-table'

const roots: string[] = []
const children: { child: ReturnType<typeof spawnProcess>; closed: Promise<unknown> }[] = []
const observations: Promise<void>[] = []
function isolatedHome(home: string) {
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_RUNTIME_DIR: join(home, 'runtime'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    ORCA_CODEX_HOME: join(home, '.codex'),
    ORCA_CLAUDE_INJECTED_CONFIG_DIR: '',
    ORCA_USER_DATA_PATH: join(home, 'user-data'),
    ORCA_E2E_USER_DATA_DIR: join(home, 'user-data'),
    ORCA_E2E_HOME_DIR: home,
    ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
    ORCA_BACKGROUND_LAUNCH: '1'
  }
}
beforeEach(async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pr31199-sl-parent-')))
  roots.push(home)
  for (const [key, value] of Object.entries(isolatedHome(home))) {
    vi.stubEnv(key, value)
  }
})
afterEach(async () => {
  for (const { child } of children) {
    if (child.connected) {
      child.send('shutdown')
    }
  }
  console.log(
    'SL_PROCESS_CHILDREN_JOINED',
    JSON.stringify(await Promise.all(children.splice(0).map(({ closed }) => closed)))
  )
  await Promise.all(observations.splice(0))
  console.log('SL_PROCESS_OBSERVATIONS_JOINED')
  for (const path of roots.splice(0)) {
    await rm(path, { recursive: true, force: true })
    console.log('SL_PROCESS_HOME_REMOVED', path)
  }
  vi.unstubAllEnvs()
})

async function fixture(realNative = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pr31199-sl-process-')))
  roots.push(root)
  const home = join(root, 'home')
  await mkdir(home)
  let entryRoot = root
  if (realNative) {
    const scratch = join(process.cwd(), 'test-results')
    await mkdir(scratch, { recursive: true })
    entryRoot = await mkdtemp(join(scratch, 'pr31199-sl-native-'))
    roots.push(entryRoot)
  }
  const entry = join(entryRoot, 'entry.cjs')
  await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import { ClaudeHookService } from './src/main/claude/hook-service';
        import { barrier, metrics } from 'statusline-test-barrier';
        import { probeMetrics } from 'statusline-test-probes';
        import { nativeMetrics } from 'statusline-test-native';
        import { tryCreateManagedHookLock } from './src/main/agent-hooks/managed-hook-lock-records';
        import { readManagedHookHostIdentity, readManagedHookProcessIdentity } from './src/main/agent-hooks/managed-hook-owner-identity';
        import { mkdir, unlink } from 'node:fs/promises';
        import { join } from 'node:path';
        import { setAppEnvironment } from './src/shared/app-environment';
        setAppEnvironment({ getPath: () => process.env.HOME, getAppPath: () => process.cwd(), getVersion: () => 'test', isPackaged: () => false, onWillQuit: () => {}, exit: code => process.exit(code), getAppMetrics: () => [] });
        const [target, operation, mode] = process.argv.slice(2);
        if (process.env.ORCA_TEST_NATIVE_MODE) {
          Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
          const kill = process.kill.bind(process); process.kill = (pid, signal) => { if (signal === 0) nativeMetrics.signals++; return kill(pid, signal); };
        }
        const controller = new AbortController();
        let shutdown = false, settled = false;
        process.on('message', m => {
          if (m === 'cancel' || m === 'shutdown') controller.abort();
          if (m === 'cancel') process.send?.({ phase: 'canceled', aborted: controller.signal.aborted, reason: String(controller.signal.reason), settled });
          if (m === 'shutdown') { shutdown = true; if (settled && process.connected) process.disconnect(); }
        });
        process.on('disconnect', () => process.exit(0));
        const options = { target: { kind: 'system-default', configDir: target }, signal: controller.signal, claudeVersion: operation === 'retire' ? '1.0.0' : '2.1.261' };
        process.send?.({ phase: 'started', pid: process.pid });
        const service = new ClaudeHookService();
        const residues = async () => {
          const parent = join(process.env.HOME, '.orca/agent-hooks/claude-statusline/lock'); await mkdir(parent, { recursive: true });
          const host = await readManagedHookHostIdentity(), identity = await readManagedHookProcessIdentity(process.pid);
          if (!identity) throw new Error('Missing residue creator identity');
          for (let i = 0; i < Number(mode); i++) {
            const lock = join(parent, 'managed-hook-install.lock');
            if (!await tryCreateManagedHookLock(parent, lock, host, identity)) throw new Error('Unexpected residue contention');
            await unlink(lock);
          }
          return { state: 'residues' };
        };
        const start = performance.now();
        const result = operation === 'residues' ? residues() : operation === 'reset' ? service.removeSystem(options) : service.installSystem(options);
        result.then(status => {
          settled = true;
          process.send?.({ phase: 'done', status, metrics: { ...metrics, ...probeMetrics, ...nativeMetrics, elapsed: performance.now() - start } });
          if (mode !== 'release-read' || shutdown) process.disconnect();
        }, error => {
          settled = true;
          process.send?.({ phase: 'failed', error: error instanceof Error ? error.stack : String(error) });
          process.disconnect();
        });
        void barrier; void mode;`
    },
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: JSONC_PARSER_ESM_ALIAS,
    logLevel: 'silent',
    plugins: [
      {
        name: 'isolated-service-barriers',
        setup(b) {
          b.onResolve(
            { filter: /(?:windows-process-table|statusline-test-native)$/ },
            ({ namespace }) =>
              realNative && namespace === 'native'
                ? { path: join(process.cwd(), 'src/main/windows/windows-process-table.ts') }
                : { path: 'native', namespace: 'native' }
          )
          b.onLoad({ filter: /.*/, namespace: 'native' }, () => ({
            contents: realNative
              ? `
            export * from 'actual-windows-process-table';
            import { readWindowsProcessCreationTime as actual } from 'actual-windows-process-table';
            import { createRequire } from 'node:module';
            export const nativeMetrics = { nativeReads: 0, signals: 0, boundary: 'production-loader', platform: process.platform, entry: __filename, observations: [] };
            export function readWindowsProcessCreationTime(pid) {
              const started = performance.now();
              const value = actual(pid);
              const elapsed = performance.now() - started;
              nativeMetrics.nativeReads++;
              let packageResolution = null;
              try { packageResolution = createRequire(__filename).resolve('@vscode/windows-process-tree'); } catch {}
              nativeMetrics.observations.push({ pid, value, elapsed, packageResolution });
              return value;
            }
          `
              : `
            export const nativeMetrics = { nativeReads: 0, signals: 0, boundary: 'controlled-getter' };
            export function readWindowsProcessCreationTime(pid) {
              nativeMetrics.nativeReads++;
              try { process.kill(pid, 0); } catch { return null; }
              return process.env.ORCA_TEST_NATIVE_MODE === 'native' ? 1777777777000 : null;
            }
          `
          }))
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
          b.onLoad({ filter: /^electron$/, namespace: 'fixture' }, () => ({
            contents: `export const app = { getPath: () => process.env.HOME };`
          }))
          b.onResolve(
            { filter: /^(node:child_process|statusline-test-probes)$/ },
            ({ namespace }) =>
              namespace === 'probes'
                ? { path: 'node:child_process', external: true }
                : { path: 'probes', namespace: 'probes' }
          )
          b.onLoad({ filter: /.*/, namespace: 'probes' }, () => ({
            contents: `
        export * from 'node:child_process';
        import * as cp from 'node:child_process';
        import { promisify } from 'node:util';
        export const probeMetrics = { probes: 0, outstanding: 0, maxProbes: 0, cimPids: [] };
        export function execFile(...args) { return cp.execFile(...args); }
        Object.defineProperty(execFile, promisify.custom, { value: async (...args) => {
          probeMetrics.probes++; probeMetrics.maxProbes = Math.max(probeMetrics.maxProbes, ++probeMetrics.outstanding);
          try {
            if (process.env.ORCA_TEST_NATIVE_MODE && String(args[0]).endsWith('reg.exe')) return { stdout: 'MachineGuid    REG_SZ    fixture-host', stderr: '' };
            if (process.env.ORCA_TEST_NATIVE_MODE === 'conflict-proof' && String(args[0]).endsWith('powershell.exe')) {
              const pid = Number(String(args[1]).match(/ProcessId = ([0-9]+)/)?.[1]);
              if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Missing actual CIM PID');
              probeMetrics.cimPids.push(pid);
              return { stdout: '1777777777000', stderr: '' };
            }
            return await promisify(cp.execFile)(...args);
          } finally { probeMetrics.outstanding--; }
        }});`
          }))
          b.onResolve(
            { filter: /^(node:fs\/promises|statusline-test-barrier)$/ },
            ({ namespace }) =>
              namespace === 'barrier'
                ? { path: 'node:fs/promises', external: true }
                : { path: 'files', namespace: 'barrier' }
          )
          b.onLoad({ filter: /.*/, namespace: 'barrier' }, () => ({
            contents: `
        export * from 'node:fs/promises';
        import * as fs from 'node:fs/promises';
        import { join, basename } from 'node:path';
        const [target, , mode] = process.argv.slice(2);
        const settings = join(target, 'settings.json');
        let armed = true, resume;
        export const metrics = { lockListings: 0, cleanupNames: 0, rootListings: 0, ownerReads: 0 };
        export async function readdir(path,...args) {
          const names = await fs.readdir(path,...args);
          if (String(path) === join(process.env.HOME, '.orca', 'agent-hooks', 'claude-statusline', 'lock')) { metrics.lockListings++; metrics.cleanupNames += names.length; }
          if (String(path) === join(process.env.HOME, '.orca')) metrics.rootListings++;
          return names;
        }
        export const barrier = async phase => {
          if (!armed) return; armed = false;
          process.send?.({ phase }); await new Promise(resolve => { resume = resolve; });
        };
        process.on('message', m => { if (m === 'exit') process.exit(0); if (m === 'continue' || m === 'shutdown') { armed = false; resume?.(); } });
        export async function rename(a,b) {
          await fs.rename(a,b);
          if (mode === 'claiming' && basename(String(b)).startsWith('managed-hook-install.claimed-')) await barrier('claiming');
          if (String(b) === settings && mode === 'published' && JSON.parse(await fs.readFile(b,'utf8')).statusLine) await barrier('published');
          if (String(b) === settings && mode === 'retired' && !JSON.parse(await fs.readFile(b,'utf8')).statusLine) await barrier('retired');
        }
        export async function readFile(path,...args) {
          const owner = basename(String(path)).startsWith('managed-hook-install.owner-');
          if (owner) metrics.ownerReads++;
          const data = await fs.readFile(path,...args);
          if (owner && mode === 'release-read') await barrier('release-read');
          if (mode === 'snapshot' && String(path) === settings) await barrier('snapshot');
          return data;
        }
        export async function link(a,b) {
          if (mode === 'acquiring' && String(b).endsWith('managed-hook-install.lock')) await barrier('acquiring');
          return fs.link(a,b);
        }`
          }))
        }
      }
    ]
  })
  async function start(target: string, operation = 'install', mode = '', nativeMode = '') {
    const child = spawnProcess({
      program: process.execPath,
      args: [entry, join(home, target), operation, mode],
      env: {
        ...process.env,
        ...isolatedHome(home),
        ORCA_TEST_NATIVE_MODE: nativeMode
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    let childError = ''
    child.on('error', (error) => {
      childError = String(error)
    })
    const closed = new Promise<{
      pid: number | undefined
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolve) => {
      child.once('close', (code, signal) => resolve({ pid: child.pid, code, signal }))
    })
    children.push({ child, closed })
    const messages: Record<string, unknown>[] = []
    let stderr = ''
    child.stderr?.on('data', (data) => {
      stderr += String(data)
    })
    child.on('message', (message) => {
      if (isPlainObject(message)) {
        messages.push(message)
      }
    })
    const waitForPhase = async (phase: string) => {
      while (!messages.some((m) => m.phase === phase)) {
        const failure = messages.find((m) => m.phase === 'failed')
        if (failure) {
          throw new Error(`Child failed before ${phase}: ${String(failure.error)}; ${stderr}`)
        }
        const terminal = messages.find((m) => m.phase === 'done')
        if (terminal) {
          throw new Error(`Child completed before ${phase}: ${JSON.stringify(terminal)}; ${stderr}`)
        }
        await Promise.race([
          once(child, 'message'),
          closed.then((result) => {
            throw new Error(
              `Child exited before ${phase}: ${JSON.stringify(result)}; ${childError}; ${stderr}`
            )
          })
        ])
      }
      return messages.find((m) => m.phase === phase)!
    }
    await waitForPhase('started')
    expect(child.pid).toBeGreaterThan(0)
    observations.push(
      readManagedHookProcessIdentity(child.pid!).then(
        (identity) => {
          console.log('SL_OWNED_PROCESS', JSON.stringify({ pid: child.pid, identity }))
        },
        (error) => {
          console.log('SL_OWNED_PROCESS', JSON.stringify({ pid: child.pid, error: String(error) }))
        }
      )
    )
    return {
      child,
      closed,
      wait: waitForPhase,
      stderr: () => stderr,
      metrics: async () => (await waitForPhase('done')).metrics,
      done: async () => {
        const result = await waitForPhase('done')
        await closed
        if (!isPlainObject(result.status)) {
          throw new Error('Missing child service status')
        }
        return result.status
      }
    }
  }
  return { root, home, start, settings: (name: string) => join(home, name, 'settings.json') }
}

// Real child processes hold the owner beyond the former 10s lease before reset and recovery.
it('orders publication, live-owner contention past lease age, canceled admission, reset and abandoned-owner recovery across real processes', async () => {
  const f = await fixture()
  expect(f.home).not.toBe(homedir())
  const p = await f.start('X', 'install', 'published')
  await p.wait('published')
  const publishedAt = performance.now()
  // ast-grep-ignore: test-no-real-time-wait -- A real live owner must remain protected beyond the former 10s lease across processes.
  await delay(10_100)
  const q = await f.start('X', 'reset')
  expect((await q.done()).state).toBe('error')
  expect(JSON.parse(await readFile(f.settings('X'), 'utf8')).statusLine).toBeDefined()
  const canceled = await f.start('other', 'install', 'acquiring')
  await canceled.wait('acquiring')
  canceled.child.send('cancel')
  const acknowledgment = await canceled.wait('canceled')
  expect(acknowledgment).toMatchObject({ aborted: true, settled: false })
  expect(acknowledgment.reason).toContain('AbortError')
  canceled.child.send('continue')
  const canceledStatus = await canceled.done()
  console.log('SL_CALLER_CANCELED_ADMISSION', JSON.stringify({ acknowledgment, canceledStatus }))
  expect(canceledStatus.state).toBe('error')
  expect(canceledStatus.detail).toContain('AbortError')
  await expect(readFile(f.settings('other'))).rejects.toMatchObject({ code: 'ENOENT' })
  p.child.send('continue')
  expect((await p.done()).state).toBe('installed')
  const reset = await f.start('X', 'reset')
  expect((await reset.done()).state).toBe('not_installed')
  expect(JSON.parse(await readFile(f.settings('X'), 'utf8')).statusLine).toBeUndefined()
  const abandoned = await f.start('X', 'install', 'published')
  await abandoned.wait('published')
  abandoned.child.send('exit')
  await abandoned.closed
  const recovery = await f.start('X')
  expect((await recovery.done()).state).toBe('installed')
  console.log('SL_LIVE_OWNER_PAUSE', performance.now() - publishedAt)
}, 30_000)

it('serializes current event snapshots, off, fresh user slots and retirement across processes', async () => {
  const f = await fixture()
  expect((await (await f.start('X')).done()).state).toBe('installed')
  const event = await f.start('X', 'install', 'snapshot')
  await event.wait('snapshot')
  expect((await (await f.start('X', 'reset')).done()).state).toBe('error')
  const user = { statusLine: { type: 'command', command: '/user/new' } }
  event.child.send('continue')
  expect((await event.done()).state).toBe('installed')
  expect((await (await f.start('X', 'reset')).done()).state).toBe('not_installed')
  expect(JSON.parse(await readFile(f.settings('X'), 'utf8')).statusLine).toBeUndefined()
  await writeFile(f.settings('X'), JSON.stringify(user))
  expect((await (await f.start('X')).done()).state).toBe('installed')
  expect((await (await f.start('X', 'reset')).done()).state).toBe('not_installed')
  expect(JSON.parse(await readFile(f.settings('X'), 'utf8')).statusLine).toEqual(user.statusLine)
  await writeFile(f.settings('X'), '{}')
  expect((await (await f.start('X')).done()).state).toBe('installed')
  const retiring = await f.start('X', 'retire', 'retired')
  await retiring.wait('retired')
  expect((await (await f.start('X')).done()).state).toBe('error')
  retiring.child.send('continue')
  expect((await retiring.done()).state).toBe('installed')
  expect((await (await f.start('X')).done()).state).toBe('installed')
  expect(JSON.parse(await readFile(f.settings('X'), 'utf8')).statusLine).toBeDefined()
})

// Real child processes create and clean L=6/60 owner records on both evidence paths.
it('cleans actual abandoned owner records with O(L) probes and two cleanup chains without listing unrelated names', async () => {
  const rows: { population: number; metrics: Record<string, unknown> }[] = []
  for (const population of [6, 60]) {
    const f = await fixture()
    const creator = await f.start('unused', 'residues', String(population))
    expect((await creator.done()).state).toBe('residues')
    for (let index = 0; index < 1000; index++) {
      await writeFile(join(f.home, '.orca', `unrelated-${index}`), '')
    }
    const next = await f.start('X')
    expect((await next.done()).state).toBe('installed')
    const metrics = await next.metrics()
    if (!isPlainObject(metrics)) {
      throw new Error('Missing cleanup counters')
    }
    expect(metrics.cleanupNames).toBe(population)
    expect(metrics.rootListings).toBe(0)
    expect(metrics.maxProbes).toBeLessThanOrEqual(2)
    expect(metrics.probes).toBe(
      process.platform === 'darwin' ? population + 2 : process.platform === 'win32' ? 1 : 0
    )
    rows.push({ population, metrics })
    const win = await fixture()
    expect(
      (await (await win.start('unused', 'residues', String(population), 'fallback')).done()).state
    ).toBe('residues')
    const nextWindows = await win.start('X', 'install', '', 'fallback')
    expect((await nextWindows.done()).state).toBe('installed')
    const windows = await nextWindows.metrics()
    if (!isPlainObject(windows)) {
      throw new Error('Missing scoped cleanup counters')
    }
    expect(windows.cleanupNames).toBe(population)
    expect(windows.rootListings).toBe(0)
    expect(windows.probes).toBe(1) // Host registry only; zero self/cleanup CIM.
    expect(windows.nativeReads).toBe(population + 1)
    expect(windows.signals).toBeGreaterThanOrEqual(population)
    rows.push({ population, metrics: windows })
  }
  console.log('SL_SCOPED_CLEANUP', JSON.stringify(rows))
}, 30_000)

// Real processes/fs/protocol with Windows evidence boundary fixtures; this is not native Windows proof.
it('reuses unchanged owner and live claimant evidence across actual acquire recovery iterations', async () => {
  const f = await fixture()
  const storage = join(f.home, '.orca/agent-hooks/claude-statusline')
  const lockParent = join(storage, 'lock')
  await mkdir(lockParent, { recursive: true })
  const owner = {
    token: 'f1991990-3119-4199-8199-000000000001',
    pid: process.pid,
    hostIdentity: 'win32:fixture-host',
    processIdentity: `win32:${process.pid}:1`
  }
  const lock = join(lockParent, 'managed-hook-install.lock')
  const ownerPath = join(lockParent, ownerFileName(owner.token))
  const ownerBytes = JSON.stringify(owner)
  await writeFile(ownerPath, ownerBytes)
  await link(ownerPath, lock)
  const claimant = await f.start('claimant', 'install', 'claiming', 'native')
  let counts: number[] = []
  try {
    await claimant.wait('claiming')
    const names = await readdir(lockParent)
    const claimedName = names.find((name) => name.startsWith('managed-hook-install.claimed-'))!
    const claimName = names.find((name) => name.startsWith('managed-hook-install.claim-'))!
    const claimedPath = join(lockParent, claimedName)
    const claimPath = join(lockParent, claimName)
    const claimBytes = await readFile(claimPath, 'utf8')
    const claim = JSON.parse(claimBytes)
    expect(claim.pid).toBe(claimant.child.pid)
    expect(claim.processIdentity).toBe(`win32:${claimant.child.pid}:1777777777000`)
    const canonicalStats = await lstat(lock)
    expect(canonicalStats.nlink).toBe(2)
    expect((await lstat(claimedPath)).ino).toBe(canonicalStats.ino)
    expect(await readFile(claimedPath, 'utf8')).toBe(ownerBytes)

    const contender = await f.start('contender', 'install', '', 'conflict-proof')
    const status = await contender.done()
    const metrics = await contender.metrics()
    if (!isPlainObject(metrics) || !Array.isArray(metrics.cimPids)) {
      throw new Error('Missing actual contender observations')
    }
    const cimPids = metrics.cimPids
    counts = [owner.pid, claim.pid].map(
      (pid) => cimPids.filter((observed) => observed === pid).length
    )
    console.log('SL_TWO_ROLE_ITERATIONS', JSON.stringify({ owner, claim, status, metrics, counts }))
    expect(status.state).toBe('error')
    expect(metrics.ownerReads).toBeGreaterThanOrEqual(2)
    await expect(readFile(f.settings('contender'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(lock, 'utf8')).toBe(ownerBytes)
    expect(await readFile(claimPath, 'utf8')).toBe(claimBytes)
    expect(await readFile(claimedPath, 'utf8')).toBe(ownerBytes)
    expect((await lstat(claimedPath)).nlink).toBe(2)
  } finally {
    if (claimant.child.connected) {
      claimant.child.send('continue')
    }
    console.log('SL_TWO_ROLE_CLAIMANT_JOIN', JSON.stringify(await claimant.done()))
  }
  const next = await f.start('contender', 'install', '', 'native')
  const nextStatus = await next.done()
  expect(nextStatus.state).toBe('installed')
  expect(JSON.parse(await readFile(f.settings('contender'), 'utf8')).statusLine).toBeDefined()
  const receiptName = (await readdir(storage)).find((name) => name.endsWith('.json'))!
  const receipt = JSON.parse(await readFile(join(storage, receiptName), 'utf8'))
  expect(receipt.destinations).toEqual([
    expect.objectContaining({ path: f.settings('contender'), phase: 'managed' })
  ])
  expect(await readdir(lockParent)).toEqual([])
  console.log('SL_TWO_ROLE_RECOVERY', JSON.stringify({ nextStatus, receipt, protocol: [] }))
  expect(counts).toEqual([1, 1])
})

// Real loader and filesystem/protocol; null getter results remain supported fallback evidence.
it('finishes ordinary filesystem release after a slow owner read without blocking a later process', async () => {
  const realNative = process.platform === 'win32'
  const f = await fixture(realNative)
  const nativeMode = realNative ? '' : 'native'
  const storage = join(f.home, '.orca/agent-hooks/claude-statusline')
  const lockParent = join(storage, 'lock')
  const owner = await f.start('X', 'install', 'release-read', nativeMode)
  let released = false
  try {
    await owner.wait('release-read')
    const heldAt = performance.now()
    expect(JSON.parse(await readFile(f.settings('X'), 'utf8')).statusLine).toBeDefined()
    const receiptName = (await readdir(storage)).find((name) => name.endsWith('.json'))!
    const receipt = JSON.parse(await readFile(join(storage, receiptName), 'utf8'))
    expect(receipt.destinations).toEqual([
      expect.objectContaining({ path: f.settings('X'), phase: 'managed' })
    ])
    // ast-grep-ignore: test-no-real-time-wait -- The actual release read must stay held beyond 250ms even when an opaque contender refuses immediately.
    await delay(250)
    const blocked = await f.start('other', 'install', '', nativeMode)
    const blockedStatus = await blocked.done()
    const heldMs = performance.now() - heldAt
    expect(blockedStatus.state).toBe('error')
    expect(heldMs).toBeGreaterThanOrEqual(250)
    owner.child.send('continue')
    const original = await owner.wait('done')
    expect(original.status).toMatchObject({ state: 'installed' })
    const protocol = await readdir(lockParent)
    released = !protocol.includes('managed-hook-install.lock')
    console.log(
      'SL_ORDINARY_RELEASE',
      JSON.stringify({ heldMs, original, blockedStatus, protocol, warning: owner.stderr() })
    )
    expect(protocol).toEqual([])
    const births = [process.pid, owner.child.pid!].map((pid) => {
      const started = performance.now()
      const value = readWindowsProcessCreationTime(pid)
      return { pid, value, elapsed: performance.now() - started }
    })
    console.log(
      'SL_RELEASE_NATIVE_OBSERVATIONS',
      JSON.stringify({ platform: process.platform, realNative, births, original })
    )
    const after = await f.start('other', 'install', '', nativeMode)
    const afterStatus = await after.done()
    console.log('SL_RELEASE_LIVE_OWNER_RETRY', JSON.stringify({ afterStatus, released }))
    expect(afterStatus.state).toBe('installed')
    expect(JSON.parse(await readFile(f.settings('other'), 'utf8')).statusLine).toBeDefined()
    expect(await readdir(lockParent)).toEqual([])
  } finally {
    if (owner.child.connected) {
      owner.child.send('continue')
    }
    await owner.wait('done')
    if (owner.child.connected) {
      owner.child.send('exit')
    }
    await owner.closed
    console.log('SL_RELEASE_OWNER_JOINED', owner.child.pid)
  }
  const recovery = await f.start('other', 'install', '', nativeMode)
  const status = await recovery.done()
  expect(status.state).toBe('installed')
  expect(JSON.parse(await readFile(f.settings('other'), 'utf8')).statusLine).toBeDefined()
  const receiptName = (await readdir(storage)).find((name) => name.endsWith('.json'))!
  const receipt = JSON.parse(await readFile(join(storage, receiptName), 'utf8'))
  expect(receipt.destinations).toContainEqual(
    expect.objectContaining({ path: f.settings('other'), phase: 'managed' })
  )
  expect(await readdir(lockParent)).toEqual([])
  console.log('SL_RELEASE_EXIT_RECOVERY', JSON.stringify({ status, receipt, protocol: [] }))
  expect(released).toBe(true)
})

// Real processes/fs/protocol with Windows evidence boundary fixtures; this is not native Windows proof.
it('protects native and opaque owners across real install/reset processes until true completion or exit', async () => {
  const f = await fixture()
  for (const producer of ['native', 'fallback']) {
    const owner = await f.start('X', 'install', 'published', producer)
    try {
      await owner.wait('published')
      const before = await readFile(f.settings('X'), 'utf8')
      const contender = await f.start('X', 'reset', '', 'native')
      expect((await contender.done()).state).toBe('error')
      expect(await readFile(f.settings('X'), 'utf8')).toBe(before)
    } finally {
      owner.child.send('continue')
      expect((await owner.done()).state).toBe('installed')
    }
    expect((await (await f.start('X', 'reset', '', 'fallback')).done()).state).toBe('not_installed')
    const abandoned = await f.start('X', 'install', 'published', producer)
    await abandoned.wait('published')
    abandoned.child.send('exit')
    await abandoned.closed
    expect((await (await f.start('X', 'install', '', 'fallback')).done()).state).toBe('installed')
    expect(JSON.parse(await readFile(f.settings('X'), 'utf8')).statusLine).toBeDefined()
    const storage = join(f.home, '.orca/agent-hooks/claude-statusline')
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(join(storage, 'lock'))).toEqual([])
    const receipt = (await readdir(storage)).find((name) => name.endsWith('.json'))!
    expect(JSON.parse(await readFile(join(storage, receipt), 'utf8')).destinations).toEqual([
      expect.objectContaining({ path: f.settings('X'), phase: 'managed' })
    ])

    expect((await (await f.start('X', 'reset', '', 'fallback')).done()).state).toBe('not_installed')
  }
})

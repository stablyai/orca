import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  patchNodePtyMasterCloexecSource
} = require('../relay-assets/node-pty-1.1.0-master-cloexec-patch.cjs')
const root = resolve(import.meta.dirname, '..', '..')
const fixtures = join(import.meta.dirname, '__fixtures__')
const stock = readFileSync(join(fixtures, 'node-pty-1.1.0-unix-pty.cc'), 'utf8')
const temporary = []

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    windowsHide: true,
    ...options
  })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  return result
}

function probe(addon, env = {}) {
  const result = run(
    process.execPath,
    [join(fixtures, 'node-pty-spawn-failure-probe.cjs'), addon],
    {
      env: { ...process.env, ...env }
    }
  )
  expect(result.stdout.trim()).toBe(env.ORCA_PTY_TEST_FAILURE ? 'clean failure' : 'normal spawn')
}

function stageSource(kind) {
  const dir = mkdtempSync(join(tmpdir(), 'node-pty-spawn-cleanup-'))
  temporary.push(dir)
  const packageDir = kind === 'relay' ? join(dir, 'node_modules', 'node-pty') : dir
  mkdirSync(join(packageDir, 'src', 'unix'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ version: '1.1.0' }))
  const path = join(packageDir, 'src', 'unix', 'pty.cc')
  writeFileSync(path, stock)
  if (kind === 'relay') {
    patchNodePtyMasterCloexecSource(dir)
  } else {
    run(
      'git',
      [
        '-c',
        'core.autocrlf=false',
        'apply',
        '--include=src/unix/pty.cc',
        join(root, 'config', 'patches', 'node-pty@1.1.0.patch')
      ],
      { cwd: dir }
    )
  }
  return { dir, source: readFileSync(path, 'utf8') }
}

afterAll(() => {
  for (const dir of temporary) {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps desktop and relay cleanup identical on both Unix spawn paths', () => {
  const desktop = stageSource('desktop').source
  const relay = stageSource('relay').source
  const cleanup = (source) =>
    source.match(
      /static int\npty_cleanup_failed_spawn\(int master, pid_t pid\) \{[\s\S]*?\n\}/
    )?.[0]
  expect(cleanup(desktop)).toBeTruthy()
  expect(cleanup(desktop)).toBe(cleanup(relay))
  const diagnostic = (source) =>
    source.match(
      /static Napi::Error\npty_failed_spawn_error\(Napi::Env env,[^\n]+\) \{[\s\S]*?\n\}/
    )?.[0]
  expect(diagnostic(desktop)).toBeTruthy()
  expect(diagnostic(desktop)).toBe(diagnostic(relay))
  for (const source of [desktop, relay]) {
    for (const mode of ['nonblocking', 'close-on-exec']) {
      const pattern = new RegExp(
        `throw pty_failed_spawn_error\\(napiEnv, "Could not set master fd to ${mode}\\.", master, pid\\)`,
        'g'
      )
      expect([...source.matchAll(pattern)]).toHaveLength(2)
    }
  }
})

// The fault-injected addon exercises Linux's actual forkpty parent path.
describe.skipIf(process.platform !== 'linux')('node-pty failed spawn resource ownership', () => {
  for (const kind of ['desktop', 'relay']) {
    describe(kind, () => {
      let addon
      beforeAll(() => {
        const staged = stageSource(kind)
        const injection = readFileSync(join(fixtures, 'node-pty-spawn-failure-injection.h'), 'utf8')
        const source = staged.source
          .replace('struct ExitEvent {', `${injection}\nstruct ExitEvent {`)
          .replace(
            '  exports.Set("fork",',
            '  exports.Set("testSpawnState", Napi::Function::New(env, TestSpawnState));\n  exports.Set("fork",'
          )
        const path = join(staged.dir, 'instrumented.cc')
        writeFileSync(path, source)
        addon = join(staged.dir, 'pty.node')
        const nodeHeaders = process.env.npm_config_nodedir
          ? join(process.env.npm_config_nodedir, 'include', 'node')
          : resolve(dirname(process.execPath), '..', 'include', 'node')
        const napiHeaders = dirname(
          require.resolve('node-addon-api', { paths: [require.resolve('node-pty')] })
        )
        run('c++', [
          '-shared',
          '-fPIC',
          '-std=c++17',
          '-pthread',
          '-DNAPI_CPP_EXCEPTIONS',
          '-I',
          nodeHeaders,
          '-I',
          napiHeaders,
          path,
          '-o',
          addon,
          '-Wl,--no-as-needed,-l:libutil.so.1,-l:libpthread.so.0,--as-needed'
        ])
      })
      it.each(['F_GETFL', 'F_SETFL', 'F_GETFD', 'F_SETFD'])(
        'cleans up after %s fails',
        (failure) => {
          probe(addon, { ORCA_PTY_TEST_FAILURE: failure })
        }
      )
      it.each(['WAIT_INITIAL', 'WAIT_FINAL', 'KILL_EPERM'])(
        'reports incomplete child cleanup after %s without blocking on an unsignalled child',
        (failure) => {
          probe(addon, {
            ORCA_PTY_TEST_FAILURE: 'F_SETFD',
            ORCA_PTY_TEST_CLEANUP_FAILURE: failure
          })
        }
      )
      it('reaps a child when its death races the termination signal', () => {
        probe(addon, {
          ORCA_PTY_TEST_FAILURE: 'F_SETFD',
          ORCA_PTY_TEST_CLEANUP_FAILURE: 'KILL_ESRCH'
        })
      })
      it('retries interrupted waits', () => {
        probe(addon, { ORCA_PTY_TEST_FAILURE: 'F_SETFD', ORCA_PTY_TEST_EINTR: '1' })
      })
      it('does not signal a child that has already been reaped', () => {
        probe(addon, { ORCA_PTY_TEST_FAILURE: 'F_SETFD', ORCA_PTY_TEST_REAPED: '1' })
      })
      it('transfers ownership and reports normal exit after a successful spawn', () => {
        probe(addon)
      })
    })
  }
})

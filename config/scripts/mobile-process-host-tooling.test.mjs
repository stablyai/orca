import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'

const repository = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const tsx = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs')
const manifest = JSON.parse(readFileSync(join(repository, 'mobile', 'package.json'), 'utf8'))
const temporary = []

afterEach(() => {
  for (const root of temporary.splice(0)) {
    removeTreeSync(root)
  }
})

function standaloneMobile() {
  const root = mkdtempSync(join(tmpdir(), 'orca-mobile-process-tooling-'))
  temporary.push(root)
  const mobile = join(root, 'mobile')
  const dependency = manifest.devDependencies['@orca/process-host']
  expect(dependency).toBe('link:../src/packages/process-host')
  const packageDir = resolve(mobile, dependency.slice('link:'.length))
  mkdirSync(packageDir, { recursive: true })
  for (const file of ['package.json', 'src']) {
    cpSync(join(repository, 'src', 'packages', 'process-host', file), join(packageDir, file), {
      recursive: true
    })
  }
  for (const file of [
    'scripts',
    'src/test-support/rpc-recording',
    'rpc-foundation/pilot-scenarios.json'
  ]) {
    const destination = join(mobile, file)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(repository, 'mobile', file), destination, { recursive: true })
  }
  writeFileSync(join(mobile, 'package.json'), JSON.stringify(manifest))
  mkdirSync(join(mobile, 'rpc-foundation', 'goldens'), { recursive: true })
  mkdirSync(join(mobile, 'node_modules', '@orca'), { recursive: true })
  symlinkSync(
    packageDir,
    join(mobile, 'node_modules', '@orca', 'process-host'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  expect(existsSync(join(root, 'node_modules'))).toBe(false)
  expect(existsSync(join(packageDir, 'dist'))).toBe(false)
  return { root, mobile }
}

function command(cwd, program, args) {
  return runProcessSync({
    program,
    args,
    cwd,
    timeoutMs: 15_000,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', ORCA_BACKGROUND_LAUNCH: '1' }
  })
}

function rpcCommand(mobile, script, args) {
  const [launcher, ...invocation] = manifest.scripts[script].split(' ')
  expect(launcher).toBe('tsx')
  return command(mobile, process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath, [
    tsx,
    ...invocation,
    ...args
  ])
}

it('runs the RPC diff with a mobile-only dependency link and no compiled host package', () => {
  const { root, mobile } = standaloneMobile()
  const init = command(root, 'git', ['init'])
  expect(init.code, init.stderr).toBe(0)
  const commit = command(root, 'git', [
    '-c',
    'user.name=Orca Test',
    '-c',
    'user.email=orca-test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    `core.hooksPath=${join(root, 'no-hooks')}`,
    'commit',
    '--allow-empty',
    '-m',
    'fixture'
  ])
  expect(commit.code, commit.stderr).toBe(0)
  const result = rpcCommand(mobile, 'rpc:diff', ['HEAD'])
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain('No recorded behaviour moved')
})

it('launches the recording runner with a mobile-only dependency link and no compiled host package', () => {
  const { mobile } = standaloneMobile()
  const vitest = join(mobile, 'node_modules', 'vitest')
  mkdirSync(vitest)
  writeFileSync(join(vitest, 'package.json'), '{"name":"vitest","version":"0.0.0"}')
  writeFileSync(
    join(vitest, 'vitest.mjs'),
    'process.stdout.write(JSON.stringify(process.argv.slice(2)))'
  )
  const { scenarios } = JSON.parse(
    readFileSync(join(mobile, 'rpc-foundation', 'pilot-scenarios.json'), 'utf8')
  )
  const result = rpcCommand(mobile, 'rpc:record', [scenarios[0].id])
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual([
    'run',
    'src/test-support/rpc-recording/pilot-recordings.test.ts',
    'src/test-support/rpc-recording/family-recordings.test.ts',
    '-t',
    expect.any(String)
  ])
})

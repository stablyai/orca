import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '../../src/shared/child-process/run-process'

const buildScript = fileURLToPath(new URL('./build-native-for-platform.mjs', import.meta.url))
const directories = []
const children = []
const buildPids = new Set()

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
  }
  for (const pid of buildPids) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }
  buildPids.clear()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function startBuild(mode, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-native-build-test-'))
  directories.push(directory)
  const cli = join(directory, 'fake-pnpm.mjs')
  const journal = join(directory, 'events.jsonl')
  writeFileSync(journal, '')
  mkdirSync(join(directory, 'config', 'scripts'), { recursive: true })
  writeFileSync(
    join(directory, 'config', 'scripts', 'build-windows-cli-launcher.mjs'),
    "console.log('windows launcher only')"
  )
  writeFileSync(
    cli,
    `
    import { appendFileSync, existsSync } from 'node:fs'
    import { spawn } from 'node:child_process'
    const name = process.argv.at(-1)
    const delay = name.includes('computer') ? 0 : name.includes('keyboard') ? 200 : 400
    const record = (event) => appendFileSync(process.env.NATIVE_BUILD_JOURNAL, JSON.stringify({ name, event, pid: process.pid }) + '\\n')
    const finish = (signal) => { record(signal); process.exit(0) }
    if (process.env.NATIVE_BUILD_MODE !== 'signal-default') process.on('SIGTERM', () => { if (process.env.NATIVE_BUILD_MODE !== 'ignore') setTimeout(() => finish('SIGTERM'), delay) })
    if (process.env.NATIVE_BUILD_MODE !== 'signal-default' || !name.includes('computer')) process.on('SIGINT', () => setTimeout(() => finish('SIGINT'), delay))
    record('started')
    process.stdout.write('ready ' + process.pid + '\\n')
    if (process.env.NATIVE_BUILD_MODE === 'descendant') {
      spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGTERM', () => {}); console.log('descendant ' + process.pid); setInterval(() => {}, 1000)")}], { stdio: 'inherit' })
    }
    setInterval(() => {
      if (!existsSync(process.env.NATIVE_BUILD_GATE)) return
      if (process.env.NATIVE_BUILD_MODE.startsWith('output-closed-')) {
        const target = process.env.NATIVE_BUILD_MODE.endsWith('stderr') ? process.stderr : process.stdout
        if (name.includes('computer')) target.write('compiler progress\\n')
        return
      }
      if (process.env.NATIVE_BUILD_MODE === 'success') { record('completed'); process.exit(0) }
      if (name.includes('computer')) { record('failed'); process.exit(7) }
    }, 10)
  `
  )
  const child = spawnProcess({
    program: process.execPath,
    args: [
      ...(options.platform
        ? [
            '--import',
            `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process, 'platform', { value: '${options.platform}' })`)}`
          ]
        : []),
      ...(options.lateOutputError
        ? [
            '--import',
            `data:text/javascript,${encodeURIComponent(`process.once('beforeExit', () => process.${options.lateOutputError}.emit('error', new Error('late output failure')))`)}`
          ]
        : []),
      buildScript
    ],
    cwd: directory,
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      npm_execpath: options.missingCli ? join(directory, 'missing-pnpm') : cli,
      NATIVE_BUILD_JOURNAL: journal,
      NATIVE_BUILD_GATE: join(directory, 'release'),
      NATIVE_BUILD_MODE: mode
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(child)
  let output = ''
  let stderr = ''
  let descendantPids = []
  let readyResolve
  const ready = new Promise((resolve) => {
    readyResolve = resolve
  })
  child.stdout.on('data', (chunk) => {
    output += chunk.toString()
    const pids = [...output.matchAll(/ready (\d+)/g)].map((match) => Number(match[1]))
    descendantPids = [...output.matchAll(/descendant (\d+)/g)].map((match) => Number(match[1]))
    for (const pid of pids) {
      buildPids.add(pid)
    }
    if (pids.length === 3 && (mode !== 'descendant' || descendantPids.length === 3)) {
      readyResolve()
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, output, stderr }))
  })
  return {
    child,
    ready,
    closed,
    descendants: () => descendantPids,
    release: () => writeFileSync(join(directory, 'release'), ''),
    events: () =>
      readFileSync(journal, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
  }
}

describe.skipIf(process.platform !== 'darwin')('parallel native builds', () => {
  it('starts every independent build before any completes', async () => {
    const build = startBuild('success')
    await build.ready
    expect(build.events().map(({ event }) => event)).toEqual(['started', 'started', 'started'])
    build.release()
    expect(await build.closed).toMatchObject({ code: 0, signal: null })
    expect(build.events().filter(({ event }) => event === 'completed')).toHaveLength(3)
  })

  it.each(['SIGINT', 'SIGTERM'])('waits for every sibling before re-raising %s', async (signal) => {
    const build = startBuild('signal')
    await build.ready
    build.child.kill(signal)
    expect(await build.closed).toMatchObject({ code: null, signal })
    expect(build.events().filter(({ event }) => event === signal)).toHaveLength(3)
  })

  it('waits for sibling cancellation when a build fails', async () => {
    const build = startBuild('failure')
    await build.ready
    build.release()
    expect(await build.closed).toMatchObject({ code: 7, signal: null })
    expect(build.events().filter(({ event }) => event === 'SIGTERM')).toHaveLength(2)
  })

  it('lets siblings finish SIGINT cleanup when one child uses the default handler', async () => {
    const build = startBuild('signal-default')
    await build.ready
    build.child.kill('SIGINT')
    expect(await build.closed).toMatchObject({ code: null, signal: 'SIGINT' })
    expect(build.events().filter(({ event }) => event === 'SIGINT')).toHaveLength(2)
  })

  it('forces a sibling that ignores graceful cancellation to exit', async () => {
    const build = startBuild('ignore')
    await build.ready
    build.release()
    expect(await build.closed).toMatchObject({ code: 7, signal: null })
    for (const { pid } of build.events().filter(({ event }) => event === 'started')) {
      expect(() => process.kill(pid, 0)).toThrow()
    }
  })

  it.each(['stdout', 'stderr'])(
    'stops quiet siblings when the %s consumer closes',
    async (target) => {
      const build = startBuild(`output-closed-${target}`)
      await build.ready
      build.child[target].destroy()
      build.release()

      const result = await build.closed
      expect(result).toMatchObject({ code: 1, signal: null })
      expect(result.stderr).not.toContain('Unhandled')
      for (const { pid } of build.events().filter(({ event }) => event === 'started')) {
        expect(() => process.kill(pid, 0)).toThrow()
      }
    }
  )

  it.each(['stdout', 'stderr'])(
    'fails on a late %s error after successful child exits',
    async (target) => {
      const build = startBuild('success', { lateOutputError: target })
      await build.ready
      build.release()

      const result = await build.closed
      expect(result).toMatchObject({ code: 1, signal: null })
      expect(result.stderr).not.toContain('Unhandled')
      expect(build.events().filter(({ event }) => event === 'completed')).toHaveLength(3)
    }
  )

  it('reports a missing build command without waiting forever', async () => {
    const build = startBuild('success', { missingCli: true })
    expect(await build.closed).toMatchObject({ code: 1, signal: null })
  })

  it('reaps compiler descendants that retain pipes after their launcher exits', async () => {
    const build = startBuild('descendant')
    await build.ready
    build.child.kill('SIGTERM')
    expect(await build.closed).toMatchObject({ code: null, signal: 'SIGTERM' })
    for (const pid of build.descendants()) {
      expect(() => process.kill(pid, 0)).toThrow()
    }
  })

  it.each(['linux', 'win32'])('keeps the %s entry point out of macOS builds', async (platform) => {
    const build = startBuild('success', { platform })
    const result = await build.closed
    expect(result).toMatchObject({ code: 0, signal: null })
    expect(build.events()).toEqual([])
    expect(result.output).toContain(
      platform === 'win32'
        ? 'windows launcher only'
        : 'no macOS native computer build required on linux'
    )
  })
})

import { build } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import { ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'

const runtimePath =
  process.env.BUN_EXECUTABLE ?? resolve('out/orcad', orcadBunRuntimeFilename(process.platform))
const nodePath =
  process.env.ORCA_TEST_NODE_EXECUTABLE ?? (process.versions.bun ? 'node' : process.execPath)
let directory = ''
const children = new Set<ReturnType<typeof spawnProcess>>()
const runtimes = new Set<number>()

describe.skipIf(!existsSync(runtimePath))('real Bun launcher lifecycle', () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-bun-launcher-'))
    await copyFile(runtimePath, join(directory, orcadBunRuntimeFilename(process.platform)))
    await writeFile(join(directory, '.build-target'), `${process.platform}-${process.arch}\n`)
    await build({
      // Record entry before imports without relying on either process's stdout.
      banner: {
        js: `
          function traceLauncherPhase(phase) {
            const runtime = process.versions.bun ? 'bun' : 'node'
            try {
              require('node:fs').appendFileSync(process.env.ORCA_TEST_PHASES + '.' + runtime,
                JSON.stringify({ at: Date.now(), phase, pid: process.pid, runtime, arch: process.arch }) + '\\n')
            } catch (error) {
              console.error('launcher fixture trace failed:', error)
            }
          }
          traceLauncherPhase('entry')
          process.once('exit', code => traceLauncherPhase('exit:' + code))
        `
      },
      stdin: {
        contents: `
          import {handoffToBundledOrcad, OrcadBundledRuntimeError} from './src/main/orcad/orcad-bundled-runtime'
          import {installOrcadShutdownSignals} from './src/main/orcad/orcad-lifecycle'
          import {resolveOrcadExitCode} from './src/main/orcad/orcad-exit-code'
          import {writeFile} from 'node:fs/promises'
          if (!process.versions.bun) {
            traceLauncherPhase('before-handoff')
            if (!handoffToBundledOrcad()) throw new Error('Missing bundled runtime')
            traceLauncherPhase('after-handoff')
            process.on('message', signal => process.emit(signal))
          } else {
            traceLauncherPhase('before-booting')
            console.log('booting:' + process.pid)
            console.log('runtime:' + process.versions.bun)
            console.log('channel-env:' + (process.env.ORCA_BUNDLED_LAUNCHER_CHANNEL ?? 'absent'))
            traceLauncherPhase('booting-written')
            process.on('exit', code => console.log('runtime-exit:' + code))
            const keepalive = setInterval(() => {}, 1_000)
            const install = async () => {
              if (process.env.ORCA_TEST_FAIL_STARTUP === '1') {
                const startup = new Promise((_, reject) => setTimeout(() =>
                  reject(new OrcadBundledRuntimeError('startup configuration failed')), 100))
                installOrcadShutdownSignals(async () => (await startup).stop())
                await startup
                return
              }
              installOrcadShutdownSignals(async () => {
                console.log('flushing')
                clearInterval(keepalive)
                if (process.env.ORCA_TEST_STALL === '1') await new Promise(() => {})
                await new Promise(resolve => setTimeout(resolve, 150))
                await writeFile(process.env.ORCA_TEST_DONE, 'flushed')
              }, process.env.ORCA_TEST_STALL === '1' ? 100 : undefined)
              console.log('ready')
            }
            // Exercise the shutdown observer before the outer startup-failure reporter.
            const start = () => Promise.resolve().then(install)
              .catch(error => setImmediate(() => process.exit(resolveOrcadExitCode(error))))
            if (process.env.ORCA_TEST_DELAY_INSTALL === '1') setTimeout(start, 300)
            else start()
          }
        `,
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      outfile: join(directory, 'orcad.js'),
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs'
    })
  })

  afterEach(() => {
    for (const child of children) {
      child.kill('SIGKILL')
    }
    children.clear()
    for (const pid of runtimes) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    runtimes.clear()
    removeTreeSync(directory)
  })

  function launch(
    options: {
      direct?: boolean
      nohup?: boolean
      delay?: boolean
      stall?: boolean
      failStartup?: boolean
    } = {}
  ) {
    const runtime = options.direct
      ? join(directory, orcadBunRuntimeFilename(process.platform))
      : nodePath
    const startedAt = Date.now()
    const events: { at: number; event: string }[] = []
    const record = (event: string): void => {
      if (events.length < 16) {
        events.push({ at: Date.now(), event })
      }
    }
    const child = spawnProcess({
      program: options.nohup ? 'nohup' : runtime,
      args: [...(options.nohup ? [runtime] : []), join(directory, 'orcad.js')],
      env: {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_TEST_DONE: join(directory, 'done'),
        ORCA_TEST_PHASES: join(directory, 'phases'),
        ORCA_TEST_DELAY_INSTALL: options.delay ? '1' : '0',
        ORCA_TEST_STALL: options.stall ? '1' : '0',
        ORCA_TEST_FAIL_STARTUP: options.failStartup ? '1' : '0'
      },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    children.add(child)
    child.once('spawn', () => record('spawn'))
    let closed = false
    child.once('close', () => {
      record('close')
      closed = true
    })
    let output = ''
    const capture = (chunk: Buffer): void => {
      output += chunk.toString()
      const pid = /booting:(\d+)/.exec(output)?.[1]
      if (pid && !output.includes('runtime-exit:')) {
        runtimes.add(Number(pid))
      } else if (pid) {
        runtimes.delete(Number(pid))
      }
    }
    const streams = [
      ['stdout', child.stdout],
      ['stderr', child.stderr]
    ] as const
    for (const [name, stream] of streams) {
      stream.on('data', capture)
      stream.once('data', () => record(`${name}:data`))
      stream.once('end', () => record(`${name}:end`))
      stream.once('close', () => record(`${name}:close`))
    }
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', (error) => {
          record(`error:${error.message}`)
          reject(error)
        })
        child.once('exit', (code, signal) => {
          record(`exit:${code}:${signal}`)
          children.delete(child)
          resolve({ code, signal })
        })
      }
    )
    const diagnostics = () => ({
      startedAt,
      elapsedMs: Date.now() - startedAt,
      events,
      pid: child.pid,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      connected: child.connected,
      closed,
      streams: streams.map(([name, stream]) => ({
        name,
        ended: stream.readableEnded,
        destroyed: stream.destroyed,
        error: stream.errored?.message,
        bufferedBytes: stream.readableLength
      })),
      phases: ['node', 'bun'].map((runtime) => {
        try {
          return {
            runtime,
            trace: readFileSync(join(directory, `phases.${runtime}`), 'utf8').slice(0, 4096)
          }
        } catch (error) {
          return { runtime, error: String(error) }
        }
      })
    })
    return { child, output: () => output, exit, isClosed: () => closed, diagnostics }
  }

  it.each([false, true])(
    'drains Bun after its launcher is killed (startup pending: %s)',
    async (delay) => {
      const h = launch({ delay })
      await vi.waitFor(
        () => {
          expect(h.output()).toContain(delay ? 'booting:' : 'ready')
          expect(h.output()).toContain(`runtime:${ORCAD_BUN_VERSION}`)
          expect(h.output()).toContain('channel-env:absent')
        },
        { timeout: 5_000 }
      )
      h.child.kill('SIGKILL')
      await h.exit
      await vi.waitFor(
        async () => expect(await readFile(join(directory, 'done'), 'utf8')).toBe('flushed'),
        { timeout: 5_000 }
      )
      expect(h.output().match(/flushing/g)).toHaveLength(1)
      await vi.waitFor(() => expect(h.output()).toContain('runtime-exit:0'))
      await vi.waitFor(() => expect(h.isClosed()).toBe(true), { timeout: 5_000 })
    }
  )

  it.skipIf(process.platform === 'win32').each([false, true])(
    'survives nohup hangups and drains on TERM (direct Bun: %s)',
    async (direct) => {
      const h = launch({ direct, nohup: true })
      await vi.waitFor(() => expect(h.output()).toContain('ready'), { timeout: 5_000 })
      if (!h.child.pid) {
        throw new Error('Missing launcher pid')
      }
      process.kill(-h.child.pid, 'SIGHUP')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(h.child.exitCode).toBeNull()
      expect(h.child.signalCode).toBeNull()
      expect(h.output()).not.toContain('flushing')
      h.child.kill('SIGTERM')
      expect(await h.exit).toEqual({ code: 0, signal: null })
      expect(await readFile(join(directory, 'done'), 'utf8')).toBe('flushed')
      await vi.waitFor(() => expect(h.isClosed()).toBe(true), { timeout: 5_000 })
    }
  )

  it('keeps an unfinished shutdown alive until its failure deadline', async () => {
    const h = launch({ stall: true })
    await vi.waitFor(() => expect(h.output()).toContain('ready'), { timeout: 5_000 })
    h.child.kill('SIGKILL')
    await h.exit
    await vi.waitFor(() => expect(h.output()).toContain('runtime-exit:1'))
    expect(h.output()).toContain('exceeded 100ms')
    await vi.waitFor(() => expect(h.isClosed()).toBe(true), { timeout: 5_000 })
  })

  it.each(process.platform === 'win32' ? [false, true] : [false])(
    'forwards launcher stop requests and drains once (startup pending: %s)',
    async (delay) => {
      const h = launch({ delay })
      await vi.waitFor(() => expect(h.output()).toContain(delay ? 'booting:' : 'ready'), {
        timeout: 5_000
      })
      h.child.send('SIGINT')
      h.child.send('SIGTERM')
      expect(await h.exit).toEqual({ code: 0, signal: null })
      expect(await readFile(join(directory, 'done'), 'utf8')).toBe('flushed')
      expect(h.output().match(/flushing/g)).toHaveLength(1)
      await vi.waitFor(() => expect(h.isClosed()).toBe(true), { timeout: 5_000 })
    }
  )

  it('preserves a startup configuration verdict after early launcher loss', async () => {
    const h = launch({ delay: true, failStartup: true })
    try {
      await vi.waitFor(() => expect(h.output()).toContain('booting:'), { timeout: 5_000 })
    } catch (error) {
      console.error('Bun launcher startup diagnostics:', JSON.stringify(h.diagnostics()))
      throw error
    }
    h.child.kill('SIGKILL')
    await h.exit
    await vi.waitFor(() => expect(h.output()).toContain('runtime-exit:78'), { timeout: 5_000 })
    expect(h.output()).toContain('shutdown after launcher disconnect failed')
    await vi.waitFor(() => expect(h.isClosed()).toBe(true), { timeout: 5_000 })
  })
})

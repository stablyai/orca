import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import {
  locatePinnedNodeForTests,
  skipForMissingInputs,
  writeNodeSlotFixture
} from './orcad-node-slot-fixture'

const pinnedNode = locatePinnedNodeForTests()
// Use a different Node path to exercise launcher handoff into the slot runtime.
const nodePath = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath
let directory = ''
let slotDir = ''
let slotRuntime = ''
const children = new Set<ReturnType<typeof spawnProcess>>()
const runtimes = new Set<number>()

const skip = skipForMissingInputs(
  'artifact',
  pinnedNode ? [] : ['the pinned Node (ORCA_PINNED_NODE or out/runtimes)']
)

describe.skipIf(skip)('real pinned-Node launcher lifecycle', () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-node-launcher-'))
    ;({ slotDir, runtime: slotRuntime } = await writeNodeSlotFixture(directory, pinnedNode!))
    await build({
      // Trace before imports without depending on either process stdout.
      banner: {
        js: `
          function traceLauncherPhase(phase) {
            const runtime = process.env.ORCA_TEST_ROLE === 'runtime' ? 'runtime' : 'launcher'
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
          import {handoffToBundledOrcad, isRunningAsBundledOrcadRuntime, OrcadBundledRuntimeError} from './src/main/orcad/orcad-bundled-runtime'
          import {installOrcadShutdownSignals} from './src/main/orcad/orcad-lifecycle'
          import {resolveOrcadExitCode} from './src/main/orcad/orcad-exit-code'
          import {writeFile} from 'node:fs/promises'
          process.env.ORCA_TEST_ROLE = isRunningAsBundledOrcadRuntime(__dirname) ? 'runtime' : 'launcher'
          if (process.env.ORCA_TEST_ROLE !== 'runtime') {
            traceLauncherPhase('before-handoff')
            if (!handoffToBundledOrcad()) throw new Error('Missing bundled runtime')
            traceLauncherPhase('after-handoff')
            process.on('message', signal => process.emit(signal))
          } else {
            traceLauncherPhase('before-booting')
            console.log('booting:' + process.pid)
            console.log('runtime:' + process.versions.node)
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
      outfile: join(slotDir, 'orcad.js'),
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
    const runtime = options.direct ? slotRuntime : nodePath
    const startedAt = Date.now()
    const events: { at: number; event: string }[] = []
    const record = (event: string): void => {
      if (events.length < 16) {
        events.push({ at: Date.now(), event })
      }
    }
    const child = spawnProcess({
      program: options.nohup ? 'nohup' : runtime,
      args: [...(options.nohup ? [runtime] : []), join(slotDir, 'orcad.js')],
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
    if (!child.stdout || !child.stderr) {
      throw new Error('The launcher fixture requires stdout and stderr pipes')
    }
    child.once('spawn', () => record('spawn'))
    let closed = false
    let output = ''
    const waiters: { text: string; resolve: () => void; reject: (error: Error) => void }[] = []
    const closedOutput = new Promise<void>((resolve) => {
      child.once('close', () => {
        record('close')
        closed = true
        for (const waiter of waiters.splice(0)) {
          waiter.reject(
            new Error(`Launcher closed without "${waiter.text}": ${JSON.stringify(diagnostics())}`)
          )
        }
        resolve()
      })
    })
    // Resolve on the stub's own marker, not a fixed window: slow runners only make it later.
    const waitForOutput = (text: string): Promise<void> =>
      output.includes(text)
        ? Promise.resolve()
        : closed
          ? Promise.reject(new Error(`Launcher closed without "${text}"`))
          : new Promise((resolve, reject) => waiters.push({ text, resolve, reject }))
    const capture = (chunk: Buffer): void => {
      output += chunk.toString()
      for (const waiter of waiters.filter((entry) => output.includes(entry.text))) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
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
      phases: ['launcher', 'runtime'].map((runtime) => {
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
    return { child, output: () => output, exit, closedOutput, waitForOutput, diagnostics }
  }

  it.each([false, true])(
    'drains the pinned runtime after its launcher is killed (startup pending: %s)',
    async (delay) => {
      const h = launch({ delay })
      await h.waitForOutput(delay ? 'booting:' : 'ready')
      await h.waitForOutput('channel-env:')
      expect(h.output()).toContain(`runtime:${NODE_RUNTIME_PIN.version}`)
      expect(h.output()).toContain('channel-env:absent')
      h.child.kill('SIGKILL')
      await h.exit
      // The runtime writes the flush marker before it exits.
      await h.waitForOutput('runtime-exit:0')
      expect(await readFile(join(directory, 'done'), 'utf8')).toBe('flushed')
      expect(h.output().match(/flushing/g)).toHaveLength(1)
      await h.closedOutput
    }
  )

  it.skipIf(process.platform === 'win32').each([false, true])(
    'survives nohup hangups and drains on TERM (direct runtime: %s)',
    async (direct) => {
      const h = launch({ direct, nohup: true })
      await h.waitForOutput('ready')
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
      await h.closedOutput
    }
  )

  it('keeps an unfinished shutdown alive until its failure deadline', async () => {
    const h = launch({ stall: true })
    await h.waitForOutput('ready')
    h.child.kill('SIGKILL')
    await h.exit
    await h.waitForOutput('runtime-exit:1')
    expect(h.output()).toContain('exceeded 100ms')
    await h.closedOutput
  })

  it.each(process.platform === 'win32' ? [false, true] : [false])(
    'forwards launcher stop requests and drains once (startup pending: %s)',
    async (delay) => {
      const h = launch({ delay })
      await h.waitForOutput(delay ? 'booting:' : 'ready')
      h.child.send('SIGINT')
      h.child.send('SIGTERM')
      expect(await h.exit).toEqual({ code: 0, signal: null })
      expect(await readFile(join(directory, 'done'), 'utf8')).toBe('flushed')
      expect(h.output().match(/flushing/g)).toHaveLength(1)
      await h.closedOutput
    }
  )

  it('preserves a startup configuration verdict after early launcher loss', async () => {
    const h = launch({ delay: true, failStartup: true })
    await h.waitForOutput('booting:')
    h.child.kill('SIGKILL')
    await h.exit
    await h.waitForOutput('runtime-exit:78')
    expect(h.output()).toContain('shutdown after launcher disconnect failed')
    await h.closedOutput
  })
})

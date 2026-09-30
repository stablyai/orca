import { SERVE_STOP_READY, SERVE_STOP_REQUEST } from '../../shared/serve-supervisor-control'
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'

const runtimePath =
  process.env.BUN_EXECUTABLE ?? resolve('out/orcad', orcadBunRuntimeFilename(process.platform))
let directory = ''
const children = new Set<ReturnType<typeof spawnProcess>>()
const runtimes = new Set<number>()

describe.skipIf(!existsSync(runtimePath))('real Bun launcher lifecycle', () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-bun-launcher-'))
    await copyFile(runtimePath, join(directory, orcadBunRuntimeFilename(process.platform)))
    await writeFile(join(directory, '.build-target'), `${process.platform}-${process.arch}\n`)
    await build({
      stdin: {
        contents: `
          import {installOrcadShutdownSignals} from './src/main/orcad/orcad-lifecycle'
          import {writeFile} from 'node:fs/promises'
          {
            console.log('booting:' + process.pid)
            console.log('runtime:' + process.versions.bun)
            process.on('exit', code => console.log('runtime-exit:' + code))
            const keepalive = setInterval(() => {}, 1_000)
            const install = async () => {
              installOrcadShutdownSignals(async () => {
                console.log('flushing')
                clearInterval(keepalive)
                if (process.env.ORCA_TEST_STALL === '1') await new Promise(() => {})
                await new Promise(resolve => setTimeout(resolve, 150))
                await writeFile(process.env.ORCA_TEST_DONE, 'flushed')
              }, process.env.ORCA_TEST_STALL === '1' ? 100 : undefined)
              console.log('ready')
            }
            void install()
          }
        `,
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      outfile: join(directory, 'orcad.js'),
      bundle: true,
      platform: 'node',
      target: 'es2024',
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
      nohup?: boolean
      stall?: boolean
    } = {}
  ) {
    const runtime = join(directory, orcadBunRuntimeFilename(process.platform))
    const child = spawnProcess({
      program: options.nohup ? 'nohup' : runtime,
      args: [...(options.nohup ? [runtime] : []), join(directory, 'orcad.js')],
      env: {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_TEST_DONE: join(directory, 'done'),
        ORCA_TEST_STALL: options.stall ? '1' : '0'
      },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    children.add(child)
    let closed = false
    child.once('close', () => {
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
    for (const [, stream] of streams) {
      stream.on('data', capture)
    }
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', (error) => {
          reject(error)
        })
        child.once('exit', (code, signal) => {
          children.delete(child)
          resolve({ code, signal })
        })
      }
    )
    return { child, output: () => output, exit, isClosed: () => closed }
  }

  it('drains through supervisor IPC without force-killing the runtime', async () => {
    const h = launch()
    const ready = new Promise<void>((resolve) => {
      h.child.on('message', (message) => {
        if (message === SERVE_STOP_READY) {
          resolve()
        }
      })
    })
    await ready
    h.child.send(SERVE_STOP_REQUEST)
    h.child.send(SERVE_STOP_REQUEST)
    expect(await h.exit).toEqual({ code: 0, signal: null })
    expect(await readFile(join(directory, 'done'), 'utf8')).toBe('flushed')
    expect(h.output().match(/flushing/g)).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('survives nohup hangups and drains on TERM', async () => {
    const h = launch({ nohup: true })
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
  })

  it.skipIf(process.platform === 'win32')('bounds a stalled durable shutdown', async () => {
    const h = launch({ stall: true })
    await vi.waitFor(() => expect(h.output()).toContain('ready'), { timeout: 5_000 })
    h.child.kill('SIGTERM')
    expect(await h.exit).toEqual({ code: 1, signal: null })
    expect(h.output()).toContain('exceeded 100ms')
  })
})

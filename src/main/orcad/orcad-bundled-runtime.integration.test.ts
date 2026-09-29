import { build } from 'esbuild'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import { shellEscape } from '../ssh/ssh-connection-utils'

let directory = ''
const children = new Set<ReturnType<typeof spawnProcess>>()

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-handoff-'))
  await build({
    stdin: {
      contents: `
        import { handoffToBundledOrcad, OrcadBundledRuntimeError } from './src/main/orcad/orcad-bundled-runtime'
        import { installOrcadShutdownSignals, flushOrcadProfileStoreForShutdown } from './src/main/orcad/orcad-lifecycle'
        import { writeFile } from 'node:fs/promises'
        if (process.env.ORCA_TEST_HANDOFF_CHILD === '1') {
          if (process.env.ORCA_TEST_HANDOFF_DURABLE === '1') {
            installOrcadShutdownSignals(() => flushOrcadProfileStoreForShutdown({
              flushFinalOrThrowAsync: async () => {
                console.log('flushing')
                await new Promise(resolve => setTimeout(resolve, 250))
                await writeFile(process.env.ORCA_TEST_SHUTDOWN_FILE, 'flushed')
              },
              freezeWritesAsync: async () => console.log('closed')
            }))
          }
          for (const signal of ['SIGINT', 'SIGTERM']) {
            process.on(signal, () => {
              console.log('received:' + signal)
              if (process.env.ORCA_TEST_HANDOFF_DURABLE !== '1') process.exit(29)
            })
          }
          console.log('ready:' + JSON.stringify(process.argv.slice(2)))
          console.log('child-pid:' + process.pid)
          setTimeout(() => process.exit(99), 4_000)
        } else {
          try {
            if (!handoffToBundledOrcad()) throw new Error('handoff failed')
          } catch (error) {
            console.error(error.message)
            process.exit(error instanceof OrcadBundledRuntimeError ? 78 : 1)
          }
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
  await writeFile(join(directory, '.build-target'), 'darwin-arm64\n')
  const runtime = join(directory, 'bun-runtime')
  await writeFile(
    runtime,
    `#!/bin/sh\nORCA_TEST_HANDOFF_CHILD=1 exec ${shellEscape(process.execPath)} "$@"\n`
  )
  await chmod(runtime, 0o700)
})

afterEach(async () => {
  for (const child of children) {
    child.kill('SIGKILL')
  }
  children.clear()
  await rm(directory, { recursive: true, force: true })
})

function launch(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  options: { entry?: string; nohup?: boolean } = {}
) {
  const child = spawnProcess({
    program: options.nohup ? 'nohup' : process.execPath,
    args: [
      ...(options.nohup ? [process.execPath] : []),
      options.entry ?? join(directory, 'orcad.js'),
      ...args
    ],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  })
  children.add(child)
  let output = ''
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString()
  })
  child.stderr.on('data', (data: Buffer) => {
    output += data.toString()
  })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        children.delete(child)
        resolve({ code, signal })
      })
    }
  )
  return { child, output: () => output, exit }
}

describe.skipIf(process.platform === 'win32')('bundled handoff process lifecycle', () => {
  it('refuses a partial installation before launching its adjacent runtime', async () => {
    await rm(join(directory, '.build-target'))
    const result = await runProcess({
      program: process.execPath,
      args: [join(directory, 'orcad.js')],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 5_000
    })
    expect(result.code).toBe(78)
    expect(result.stderr).toContain('bundled Orca runtime target is missing')
    expect(result.stdout).not.toContain('ready:')
  })

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'forwards %s to the actual child and mirrors its exit',
    async (signal) => {
      const args = ['--label', 'two words', 'quote"$literal']
      const { child, output, exit } = launch(args)
      await vi.waitFor(() => expect(output()).toContain(`ready:${JSON.stringify(args)}`), {
        timeout: 2_000
      })
      child.kill(signal)
      expect(await exit).toEqual({ code: 29, signal: null })
      expect(output()).toContain(`received:${signal}`)
    }
  )

  it.each(
    (['SIGINT', 'SIGTERM'] as const).flatMap((signal) =>
      (['process group', 'separate service deliveries'] as const).map((delivery) => ({
        signal,
        delivery
      }))
    )
  )(
    'finishes a pending durable flush after duplicate $signal from $delivery',
    async ({ signal, delivery }) => {
      const shutdownFile = join(directory, 'shutdown-complete')
      const { child, output, exit } = launch([], {
        ORCA_TEST_HANDOFF_DURABLE: '1',
        ORCA_TEST_SHUTDOWN_FILE: shutdownFile
      })
      await vi.waitFor(() => expect(output()).toContain('child-pid:'), { timeout: 2_000 })
      const runtimePid = Number(output().match(/child-pid:(\d+)/)?.[1])
      expect(runtimePid).toBeGreaterThan(0)
      if (!child.pid) {
        throw new Error('Launcher has no process ID')
      }
      if (delivery === 'process group') {
        process.kill(-child.pid, signal)
      } else {
        process.kill(runtimePid, signal)
        await vi.waitFor(() => expect(output()).toContain('flushing'))
        child.kill(signal)
      }
      expect(await exit).toEqual({ code: 0, signal: null })
      expect(await readFile(shutdownFile, 'utf8')).toBe('flushed')
      expect(output().match(/flushing/g)).toHaveLength(1)
      expect(output()).toContain('closed')
      if (delivery === 'separate service deliveries') {
        expect(output().match(new RegExp(`received:${signal}`, 'g'))).toHaveLength(2)
      }
    }
  )

  it('hands off a symlinked entry to its adjacent runtime', async () => {
    const aliases = join(directory, 'aliases')
    await mkdir(aliases)
    const entry = join(aliases, 'orcad.js')
    await symlink(join(directory, 'orcad.js'), entry)
    const { child, output, exit } = launch([], {}, { entry })
    await vi.waitFor(() => expect(output()).toContain('child-pid:'), { timeout: 2_000 })
    child.kill('SIGTERM')
    expect(await exit).toEqual({ code: 29, signal: null })
  })

  it('drains the child after its launcher is force-killed', async () => {
    const shutdownFile = join(directory, 'shutdown-complete')
    const { child, output, exit } = launch([], {
      ORCA_TEST_HANDOFF_DURABLE: '1',
      ORCA_TEST_SHUTDOWN_FILE: shutdownFile
    })
    await vi.waitFor(() => expect(output()).toContain('child-pid:'), { timeout: 2_000 })
    child.kill('SIGKILL')
    expect(await exit).toEqual({ code: null, signal: 'SIGKILL' })
    await vi.waitFor(async () => expect(await readFile(shutdownFile, 'utf8')).toBe('flushed'))
    expect(output().match(/flushing/g)).toHaveLength(1)
  })

  it('preserves nohup across a terminal hangup and still stops gracefully on SIGTERM', async () => {
    const shutdownFile = join(directory, 'shutdown-complete')
    const { child, output, exit } = launch(
      [],
      { ORCA_TEST_HANDOFF_DURABLE: '1', ORCA_TEST_SHUTDOWN_FILE: shutdownFile },
      { nohup: true }
    )
    await vi.waitFor(() => expect(output()).toContain('child-pid:'), { timeout: 2_000 })
    if (!child.pid) {
      throw new Error('Launcher has no process ID')
    }
    process.kill(-child.pid, 'SIGHUP')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
    expect(output()).not.toContain('flushing')
    child.kill('SIGTERM')
    expect(await exit).toEqual({ code: 0, signal: null })
    expect(await readFile(shutdownFile, 'utf8')).toBe('flushed')
  })
})

import { spawnProcess } from '@orca/process-host'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import type { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnProviderProcess, type ProviderProcessSpawner } from './provider-process-spawn'
import {
  createProviderSpawnSpec,
  type ProviderSupervisorOptions
} from './provider-process-supervisor'
import type { ProviderChild } from './provider-child'
import * as orphanGuard from './provider-group-orphan-guard'

const state = vi.hoisted<{
  root: string
  holdPublication: Promise<void> | undefined
  publicationStarted: (() => void) | undefined
}>(() => ({
  root: '',
  holdPublication: undefined,
  publicationStarted: undefined
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args)
      state.publicationStarted?.()
      await state.holdPublication
    }
  }
})
vi.mock('../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({
    getPath: () => state.root,
    getAppPath: () => process.cwd(),
    isPackaged: () => false
  })
}))

const children: { child: ProviderChild; closed: Promise<void> }[] = []
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'orca-provider-launch-'))
})
afterEach(async () => {
  for (const { child } of children) {
    child.kill('SIGKILL')
  }
  await Promise.all(children.splice(0).map(({ closed }) => closed))
  await rm(state.root, { recursive: true, force: true })
})

type LaunchOptions = {
  args?: string[]
  command?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  envToDelete?: string[]
  captureOutput?: boolean
  spawn?: ProviderProcessSpawner
}

function launch(
  script: string,
  options: ProviderSupervisorOptions = {},
  {
    args = [],
    command = process.execPath,
    cwd = state.root,
    env = process.env,
    envToDelete,
    captureOutput = true,
    spawn
  }: LaunchOptions = {}
) {
  const spec = createProviderSpawnSpec(
    { command, args: ['-e', script, '--', ...args], cwd, envToDelete },
    env,
    process.platform,
    options
  )
  const child = spawnProviderProcess(spec, spawn)
  let output = ''
  let stderr = ''
  const errors: Error[] = []
  const readers = new Set<() => void>()
  child.on('error', (error) => errors.push(error))
  if (captureOutput) {
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
      for (const reader of readers) {
        reader()
      }
    })
  }
  if (captureOutput) {
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
  }
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  children.push({ child, closed })
  const untilOutput = (text: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        readers.delete(check)
        reject(new Error(`Missing output: ${text}; ${output}; ${stderr}`))
      }, 15_000)
      const check = (): void => {
        if (output.includes(text)) {
          clearTimeout(timer)
          readers.delete(check)
          resolve()
        }
      }
      readers.add(check)
      check()
    })
  return { child, exit, closed, errors, output: () => output, stderr: () => stderr, untilOutput }
}

async function readText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe.runIf(process.platform !== 'win32')('direct provider ownership', () => {
  it.each(['old-protocol', 'missing-input'])(
    'refuses a %s helper contract before CLI execution',
    async (fault) => {
      const spec = createProviderSpawnSpec(
        { command: process.execPath, args: ['-e', "process.stdout.write('MUST NOT EXECUTE')"] },
        process.env,
        process.platform
      )
      const raw = spawnProcess({
        program: spec.program,
        args: fault === 'old-protocol' ? spec.args.slice(1) : spec.args,
        cwd: state.root,
        env: spec.env,
        stdio:
          fault === 'missing-input'
            ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe']
            : ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe']
      })
      const output = raw.stdout ? readText(raw.stdout) : Promise.resolve('')
      raw.stderr?.resume()
      const [code] = await once(raw, 'close')
      expect(code).toBe(64)
      expect(await output).toBe('')
    }
  )

  it('publishes ownership before execution, preserves argv/environment, and drains the real final output', async () => {
    const run = launch(
      String.raw`
      const fs = require('node:fs')
      const path = require('node:path')
      const records = fs.readdirSync(process.env.ORCA_TEST_JOURNAL).filter(f => f.endsWith('.json'))
      const record = JSON.parse(fs.readFileSync(path.join(process.env.ORCA_TEST_JOURNAL, records[0]), 'utf8'))
      process.stdout.write(JSON.stringify({ pid: process.pid, leader: record.leader.pid, owner: record.owner.pid,
        argv: process.argv.slice(1), env: {
          ORCA_TEST_JOURNAL: process.env.ORCA_TEST_JOURNAL,
          ORCA_TEST_LITERAL: process.env.ORCA_TEST_LITERAL,
          NODE_OPTIONS: process.env.NODE_OPTIONS, PWD: process.env.PWD,
          SHLVL: process.env.SHLVL, _: process.env._,
          ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
          ORCA_PROVIDER_SUPERVISOR_SPEC: process.env.ORCA_PROVIDER_SUPERVISOR_SPEC
        } }) + '\n')
      process.stderr.write('final stderr\n')
      process.stdout.write('final stdout\n')
    `,
      { lifetime: 'one-shot' },
      {
        args: ['', 'a b&c', '--literal=$HOME', 'line\nbreak'],
        env: {
          ORCA_TEST_JOURNAL: join(state.root, 'provider-processes'),
          ORCA_TEST_LITERAL: 'a b&c\n$HOME',
          NODE_OPTIONS: '--no-warnings',
          PWD: '/literal/pwd',
          SHLVL: '7',
          _: 'literal_underscore'
        }
      }
    )
    await expect(run.exit).resolves.toEqual({ code: 0, signal: null })
    const first = JSON.parse(run.output().split('\n')[0])
    expect(first).toEqual({
      pid: run.child.pid,
      leader: run.child.pid,
      owner: process.pid,
      argv: ['', 'a b&c', '--literal=$HOME', 'line\nbreak'],
      env: {
        ORCA_TEST_JOURNAL: join(state.root, 'provider-processes'),
        ORCA_TEST_LITERAL: 'a b&c\n$HOME',
        NODE_OPTIONS: '--no-warnings',
        PWD: '/literal/pwd',
        SHLVL: '7',
        _: 'literal_underscore'
      }
    })
    expect(run.output().split('\n').slice(1).join('\n')).toBe('final stdout\n')
    expect(run.stderr()).toBe('final stderr\n')
    expect(run.errors).toEqual([])
    expect(run.child.groupVerdict).toBe('exited')
    expect(await readdir(join(state.root, 'provider-processes'))).toEqual([])
  })

  it.each([
    { requested: '1', deleted: false, expected: '1' },
    { requested: '0', deleted: false, expected: null },
    { requested: undefined, deleted: false, expected: null },
    { requested: '1', deleted: true, expected: null }
  ])(
    'passes the final Electron Node mode to the provider for %j',
    async ({ requested, deleted, expected }) => {
      const run = launch(
        `process.stdout.write(JSON.stringify({ nodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null }))`,
        { lifetime: 'one-shot' },
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: requested },
          envToDelete: deleted ? ['ELECTRON_RUN_AS_NODE'] : []
        }
      )
      await expect(run.exit).resolves.toEqual({ code: 0, signal: null })
      expect(JSON.parse(run.output())).toEqual({ nodeMode: expected })
    }
  )

  it('retains final bytes for readers attached after lifecycle exit', async () => {
    const run = launch(
      String.raw`
      process.stdout.end('final answer 🐳\n')
      process.stderr.end('final error\n')
    `,
      { lifetime: 'one-shot' },
      { captureOutput: false }
    )
    await expect(run.exit).resolves.toEqual({ code: 0, signal: null })
    await expect(
      Promise.all([readText(run.child.stdout), readText(run.child.stderr)])
    ).resolves.toEqual(['final answer 🐳\n', 'final error\n'])
  })

  it('does not treat one-shot stdin EOF as a stop', async () => {
    const run = launch(
      String.raw`
      let input = ''
      process.stdin.on('data', chunk => input += chunk)
      process.stdin.on('end', () => setTimeout(() => process.stdout.write('answer:' + input), 1_200))
    `,
      { lifetime: 'one-shot', stdinEndGraceMs: 20, sigtermGraceMs: 20 }
    )
    run.child.stdin.end('request')
    await expect(run.exit).resolves.toEqual({ code: 0, signal: null })
    expect(run.output()).toBe('answer:request')
  })

  it('reaps descendants immediately when the leader voluntarily exits on stdin EOF', async () => {
    const run = launch(String.raw`
      require('node:child_process').spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => { process.stdout.write('unexpected TERM\\n'); process.exit(42) }); process.stdout.write('descendant ready\\n'); setInterval(() => {}, 60000)"
      ], { stdio: ['ignore', 'inherit', 'inherit'] })
      process.stdin.resume().once('end', () => process.exit(17))
    `)
    await run.untilOutput('descendant ready')
    run.child.stdin.end()
    await expect(run.exit).resolves.toEqual({ code: 17, signal: null })
    expect(run.output()).toBe('descendant ready\n')
    expect(run.child.groupVerdict).toBe('exited')
  })

  it('keeps descendants in their remaining session grace after the leader exits', async () => {
    const run = launch(
      String.raw`
      const child = require('node:child_process').spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => setTimeout(() => { process.stdout.write('descendant flushed\\n'); process.exit(0) }, 80)); process.stdout.write('descendant ready\\n'); setInterval(() => {}, 60000)"
      ], { stdio: ['ignore', 'inherit', 'inherit'] })
      process.on('SIGTERM', () => process.exit(23))
      setInterval(() => {}, 60000)
    `,
      { sigtermGraceMs: 400 }
    )
    await run.untilOutput('descendant ready')
    run.child.kill('SIGTERM')
    run.child.kill('SIGTERM')
    await expect(run.exit).resolves.toEqual({ code: 23, signal: null })
    expect(run.output()).toContain('descendant flushed')
    expect(run.child.groupVerdict).toBe('exited')
  })

  it.runIf(process.platform === 'linux')(
    'exits the native parent after the provider ends and leaves its detached daemon running',
    async () => {
      const path = join(state.root, 'daemon.sock')
      const server = createServer()
      const connected = new Promise<Socket>((resolve) => server.once('connection', resolve))
      await new Promise<void>((resolve) => server.listen(path, resolve))
      let parentExit: Promise<number | null> | undefined
      let daemonPid = 0
      try {
        const run = launch(
          String.raw`
          require('node:child_process').spawn(process.execPath, ['-e',
            "require('node:net').connect(process.argv[1]).on('data', function () { this.write('alive') }).write(String(process.pid)); setInterval(() => {}, 60000)", ${JSON.stringify(path)}
          ], { detached: true, stdio: 'ignore' }).unref()
          process.stdin.resume().once('end', () => process.exit(0))
        `,
          { lifetime: 'one-shot' },
          {
            spawn: (spec) => {
              const parent = spawnProcess(spec)
              parentExit = new Promise((resolve) => parent.once('exit', (code) => resolve(code)))
              return parent
            }
          }
        )
        const daemon = await connected
        daemonPid = Number(String((await once(daemon, 'data'))[0]))
        run.child.stdin.end()
        await expect(run.exit).resolves.toEqual({ code: 0, signal: null })
        await expect(parentExit).resolves.toBe(0)
        daemon.write('?')
        expect(String((await once(daemon, 'data'))[0])).toBe('alive')
      } finally {
        if (daemonPid > 0) {
          process.kill(daemonPid, 'SIGKILL')
        }
        server.close()
      }
    }
  )

  it('routes SIGUSR2 to immediate cleanup and retains the actual CLI signal', async () => {
    const run = launch(String.raw`
      process.on('SIGTERM', () => process.stdout.write('term received\n'))
      process.on('SIGUSR2', () => process.stdout.write('usr2 reached CLI\n'))
      process.stdout.write('ready\n')
      setInterval(() => {}, 60000)
    `)
    await run.untilOutput('ready')
    run.child.kill('SIGTERM')
    await run.untilOutput('term received')
    run.child.kill('SIGUSR2')
    await expect(run.exit).resolves.toEqual({ code: null, signal: 'SIGKILL' })
    expect(run.output()).not.toContain('usr2 reached CLI')
  })

  it('allows the full native TERM grace after a delayed watcher receives the request', async () => {
    const run = launch(
      String.raw`
      process.on('SIGTERM', () => setTimeout(() => {
        process.stdout.write('final result\n'); process.exit(0)
      }, 800))
      process.stdout.write('ready\n')
      setInterval(() => {}, 60000)
    `,
      { sigtermGraceMs: 1_000 }
    )
    await run.untilOutput('ready')
    const directory = join(state.root, 'provider-processes')
    const [name] = await readdir(directory)
    const { watcher } = JSON.parse(await readFile(join(directory, name), 'utf8'))
    process.kill(watcher.pid, 'SIGSTOP')
    try {
      run.child.kill('SIGTERM')
      await delay(500)
    } finally {
      process.kill(watcher.pid, 'SIGCONT')
    }
    await expect(run.exit).resolves.toEqual({ code: 0, signal: null })
    expect(run.output()).toBe('ready\nfinal result\n')
  })

  it('distinguishes native exec ENOENT from a CLI exit 127', async () => {
    const missing = launch(
      '',
      { lifetime: 'one-shot' },
      { command: join(state.root, 'absent-cli') }
    )
    await missing.closed
    expect(missing.errors[0]).toMatchObject({ code: 'ENOENT', providerExecutableMissing: true })
    const real = launch('process.exit(127)', { lifetime: 'one-shot' })
    await expect(real.exit).resolves.toEqual({ code: 127, signal: null })
    expect(real.errors).toEqual([])
  })

  it('classifies a missing working folder without blaming the provider executable', async () => {
    const run = launch('', { lifetime: 'one-shot' }, { cwd: join(state.root, 'missing-cwd') })
    await run.closed
    expect(run.errors[0]).toMatchObject({ code: 'ENOENT', providerLaunchFolderMissing: true })
    expect(run.errors[0]).not.toHaveProperty('providerExecutableMissing')
  })

  it('cancels a pending launch without releasing its execution gate', async () => {
    const run = launch("process.stdout.write('MUST NOT EXECUTE')", { lifetime: 'one-shot' })
    expect(run.child.pid).toBeUndefined()
    run.child.kill('SIGTERM')
    await expect(run.child.ready).rejects.toThrow()
    await run.closed
    expect(run.output()).toBe('')
    expect(run.child.pid).toBeUndefined()
  })

  it('retires a stopped launch canceled while its ownership publication is in flight', async () => {
    let release = (): void => {}
    let publicationStarted = (): void => {}
    const published = new Promise<void>((resolve) => {
      publicationStarted = resolve
    })
    state.holdPublication = new Promise<void>((resolve) => {
      release = resolve
    })
    state.publicationStarted = publicationStarted
    const marker = join(state.root, 'executed')
    const run = launch(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`, {
      lifetime: 'one-shot'
    })
    try {
      await published
      run.child.kill('SIGSTOP')
      run.child.kill('SIGKILL')
    } finally {
      release()
      state.holdPublication = undefined
      state.publicationStarted = undefined
    }
    await run.closed
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(state.root, 'provider-processes'))).toEqual([])
  })

  it('distinguishes a missing CLI from a real exit 127 on the compatibility path', async () => {
    await writeFile(join(state.root, 'provider-processes'), 'blocked')
    const missing = launch(
      '',
      { lifetime: 'one-shot' },
      { command: join(state.root, 'absent-cli') }
    )
    await missing.closed
    expect(missing.errors[0]).toMatchObject({ code: 'ENOENT', providerExecutableMissing: true })
    const real = launch('process.exit(127)', { lifetime: 'one-shot' })
    await expect(real.exit).resolves.toEqual({ code: 127, signal: null })
    expect(real.errors).toEqual([])
  })

  it('cleans the CLI group when a compatibility supervisor is killed', async () => {
    await writeFile(join(state.root, 'provider-processes'), 'blocked')
    // The compatibility guard has always required a proof captured before wrapper death.
    // A second-resolution host may need to cross the leader's start second first.
    const prove = orphanGuard.proveProviderProcessIdentity
    let armed: () => void = () => {}
    const proven = new Promise<void>((resolve) => {
      armed = resolve
    })
    const proof = vi
      .spyOn(orphanGuard, 'proveProviderProcessIdentity')
      .mockImplementation(async (...args) => {
        const identity = await prove(...args)
        if (identity) {
          armed()
        }
        return identity
      })
    try {
      const run = launch("process.stdout.write('ready\\n'); setInterval(() => {}, 60000)")
      await run.untilOutput('ready')
      await proven
      run.child.kill('SIGKILL')
      await run.closed
      expect(run.child.groupVerdict).toBe('exited')
    } finally {
      proof.mockRestore()
    }
  })

  it('keeps provider launches working through the legacy supervisor when recovery storage is unavailable', async () => {
    await writeFile(join(state.root, 'provider-processes'), 'blocked')
    const run = launch("process.stdout.end('answer from compatibility path')", {
      lifetime: 'one-shot'
    })
    await expect(run.exit).resolves.toEqual({ code: 0, signal: null })
    expect(run.output()).toBe('answer from compatibility path')
    expect(run.errors).toEqual([])
  })
})

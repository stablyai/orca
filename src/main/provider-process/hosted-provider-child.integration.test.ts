import { stopSupervisedChildProcess } from './supervised-child-process-stop'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { DaemonServer } from '../daemon/server/daemon-server'
import { DaemonClient } from '../daemon/transport/client/daemon-client'
import { HostedProviderChild } from './hosted-provider-child'
import { createProviderSpawnSpec } from './provider-process-supervisor'
import { guardSupervisedProviderGroup } from './provider-group-orphan-guard'
import type { HostedProviderState } from '../daemon/protocol/daemon-provider-process-protocol'
import { ProviderOwnerListener } from './provider-owner-channels'
import { createSupervisorOutputGate } from './provider-supervisor-output-gate.test-support'

vi.mock('../daemon/executable-host/macos/daemon-mac-code-identity', () => ({
  inspectMacProcessCodeIdentity: vi.fn(async () => ({
    identity: 'resolved',
    executablePath: '/fake/Orca Agents'
  }))
}))

describe.skipIf(process.platform === 'win32')('hosted provider production transport', () => {
  let directory: string
  let server: DaemonServer
  let client: DaemonClient
  const children = new Set<HostedProviderChild>()

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-hosted-provider-')))
    const socketPath = join(directory, 'daemon.sock')
    const tokenPath = join(directory, 'token')
    server = new DaemonServer({
      socketPath,
      tokenPath,
      providerSpawn: true,
      spawnSubprocess: () => {
        throw new Error('No PTY in provider test')
      }
    })
    await server.start()
    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
  })

  afterEach(async () => {
    for (const child of children) {
      await child.signalRoot!('SIGCONT')
      await child.signalRoot!('SIGTERM')
    }
    await server.shutdown()
    client.disconnect()
    children.clear()
    await rm(directory, { recursive: true, force: true })
  })

  function launch(
    source: string,
    lifetime: 'session' | 'one-shot' = 'one-shot',
    cwd?: string,
    instrument?: (source: string) => string
  ) {
    const spec = createProviderSpawnSpec(
      {
        command: process.execPath,
        args: ['-e', source],
        cwd: cwd ?? directory
      },
      { PATH: process.env.PATH, PROVIDER_ENV: 'from-gui' },
      process.platform,
      { lifetime }
    )
    if (instrument) {
      spec.args[1] = instrument(spec.args[1])
    }
    const child = new HostedProviderChild(
      spec,
      async () => client,
      () => {
        throw new Error('Unexpected direct fallback')
      }
    )
    children.add(child)
    child.on('error', () => {})
    guardSupervisedProviderGroup(child, { site: 'hosted-provider-fixture', supervised: true })
    return child
  }

  it('waits for real final writes after source EOF without expiring a live owner', async () => {
    const gate = await createSupervisorOutputGate(directory)
    try {
      const child = launch(
        "process.stdout.write('stdout-final'); process.stderr.write('stderr-final')",
        'one-shot',
        undefined,
        gate.instrument
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
      const closed = once(child, 'close')
      child.stdin.end()
      await gate.pending
      // ast-grep-ignore: test-no-real-time-wait -- Real child output must stay pending beyond the former one-second drain deadline.
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      expect(child.exitCode).toBeNull()
      gate.release()
      expect(await closed).toEqual([0, null])
      expect(stdout).toBe('stdout-final')
      expect(stderr).toBe('stderr-final')
    } finally {
      await gate.close()
    }
  })

  it('still stops a supervisor whose provider exited while final writes are held', async () => {
    const gate = await createSupervisorOutputGate(directory)
    try {
      const child = launch(
        "process.stdout.write('stdout-final'); process.stderr.write('stderr-final')",
        'one-shot',
        undefined,
        gate.instrument
      )
      child.stdout.resume()
      child.stderr.resume()
      child.stdin.end()
      await gate.pending
      const errors: Error[] = []
      child.on('error', (error) => errors.push(error))
      // Forced Stop can reset pending output before the child reports its actual close.
      const closed = new Promise((resolve) =>
        child.once('close', (code, signal) => resolve([code, signal]))
      )
      expect(await child.signalRoot!('SIGTERM')).toBe(true)
      expect(await closed).toEqual([null, 'SIGTERM'])
      expect(child.rootAbsent).toBe(true)
      for (const error of errors) {
        expect(error).toMatchObject({ code: 'ECONNRESET' })
      }
    } finally {
      await gate.close()
    }
  })

  it('delivers a paused final response before close after the real supervisor exits', async () => {
    const child = launch("process.stdout.write('complete-response')")
    child.stdout.pause()
    const exited = once(child, 'exit')
    let closed = false
    const completion = new Promise<void>((resolve) =>
      child.once('close', () => {
        closed = true
        resolve()
      })
    )
    await exited
    // ast-grep-ignore: test-no-real-time-wait -- Actual child exit must not close an explicitly paused reader after the former one-second deadline.
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    expect(closed).toBe(false)
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk.toString()))
    child.stdout.resume()
    await completion
    expect(output).toBe('complete-response')
    expect(child.exitCode).toBe(0)
  })

  it('also drains the public output of a direct-adoption wrapper before close', async () => {
    const rawClosed = Promise.withResolvers<void>()
    const spec = createProviderSpawnSpec(
      { command: process.execPath, args: [] },
      {},
      process.platform
    )
    const child = new HostedProviderChild(
      spec,
      async () => null,
      () => {
        const direct = spawn(process.execPath, ['-e', "process.stdout.write('direct-response')"], {
          stdio: 'pipe'
        })
        direct.once('close', () => rawClosed.resolve())
        return direct
      }
    )
    child.stdout.pause()
    let closed = false
    const completion = new Promise<void>((resolve) =>
      child.once('close', () => {
        closed = true
        resolve()
      })
    )
    await rawClosed.promise
    expect(closed).toBe(false)
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk.toString()))
    child.stdout.resume()
    await completion
    expect(output).toBe('direct-response')
  })

  it('keeps real identity, GUI env/cwd, one-shot EOF and backpressured output intact', async () => {
    const child = launch(`
      let input = ''
      process.stdin.setEncoding('utf8').on('data', value => input += value)
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({ input, parent: process.ppid, cwd: process.cwd(), env: process.env.PROVIDER_ENV, auth: process.env.ORCA_PROVIDER_OWNER_CHANNEL }) + '\\n')
        process.stdout.write('x'.repeat(2097152))
        process.stderr.write('stderr-complete\\n')
      })
    `)
    expect(child.pid).toBeUndefined()
    const closed = once(child, 'close')
    let output = ''
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })
    child.stdin.end('request-complete')
    await child.ready
    expect(child.pid).toBeGreaterThan(1)
    // Delay the reader until after spawn; the retained pipe must not discard initial output.
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk
    })
    await closed
    const newline = output.indexOf('\n')
    expect(JSON.parse(output.slice(0, newline))).toEqual({
      input: 'request-complete',
      parent: child.pid,
      cwd: directory,
      env: 'from-gui'
    })
    expect(output.slice(newline + 1)).toBe('x'.repeat(2097152))
    expect(stderr).toBe('stderr-complete\n')
    expect(child.exitCode).toBe(0)
  })

  it('reattaches lifecycle reporting after a daemon connection loss and acknowledges a stopped root', async () => {
    const child = launch("process.stdout.write('running\\n'); setInterval(() => {}, 1000)")
    child.stdout.resume()
    child.stderr.resume()
    await child.ready
    const pid = child.pid
    client.disconnect()
    await client.ensureConnected()
    // A new request exercises the replacement authenticated pair while the raw owner socket survives.
    await client.request('ping', undefined)
    expect(child.pid).toBe(pid)
    expect(await child.signalRoot!('SIGSTOP')).toBe(true)
    expect(await child.signalRoot!('SIGCONT')).toBe(true)
    const exit = once(child, 'exit')
    expect(await child.signalRoot!('SIGTERM')).toBe(true)
    expect(await exit).toEqual([null, 'SIGTERM'])
  })

  it('retains real outcomes until acknowledged; unknown nonces never prove absence', async () => {
    const nonce = 'a'.repeat(64)
    const exit = new Promise<void>((resolve) => {
      const remove = client.onProviderExit(nonce, () => {
        remove()
        resolve()
      })
    })
    const { pid } = await client.request<{ pid: number }>('spawnProvider', {
      nonce,
      source: 'process.exit(7)',
      args: [],
      cwd: directory,
      env: {}
    })
    await exit
    client.disconnect()
    await client.ensureConnected()
    const outcome = await client.request<HostedProviderState>('queryProvider', { nonce })
    expect(outcome).toEqual({
      state: 'exited',
      outcome: { pid, code: 7, signal: null, processless: false }
    })
    expect(await client.request('queryProvider', { nonce, acknowledge: true })).toEqual(outcome)
    expect(await client.request('queryProvider', { nonce })).toEqual({ state: 'unknown' })
  })

  it('ends a session when the GUI owner socket closes while the host stays alive', async () => {
    const owner = new ProviderOwnerListener()
    try {
      const path = await owner.listen()
      const spec = createProviderSpawnSpec(
        {
          command: process.execPath,
          args: ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
          cwd: directory
        },
        {},
        process.platform
      )
      const exited = new Promise<HostedProviderState>((resolve) => {
        const remove = client.onProviderExit(owner.nonce, (outcome) => {
          remove()
          resolve({ state: 'exited', outcome })
        })
      })
      const { pid } = await client.request<{ pid: number }>('spawnProvider', {
        nonce: owner.nonce,
        source: spec.args[1],
        args: spec.args.slice(3),
        cwd: spec.cwd,
        env: {
          ...spec.env,
          ORCA_PROVIDER_OWNER_CHANNEL: JSON.stringify({ path, nonce: owner.nonce })
        }
      })
      owner.bindPid(pid)
      const channels = await owner.ready
      channels.stderr.resume()
      channels.control.resume()
      const output = once(channels.duplex, 'data')
      channels.duplex.resume()
      channels.control.write('{"go":true}\n')
      expect(String((await output)[0])).toBe('ready')
      await owner.close()
      expect(await exited).toEqual({
        state: 'exited',
        outcome: { pid, code: 137, signal: null, processless: false }
      })
      await expect(client.request('ping', undefined)).resolves.toBeDefined()
    } finally {
      await owner.close()
    }
  })

  it('keeps exit reporting alive while host shutdown reaps its running provider', async () => {
    const child = launch("process.stdout.write('ready'); setInterval(() => {}, 1000)", 'session')
    const output = once(child.stdout, 'data')
    child.stderr.resume()
    await child.ready
    expect(String((await output)[0])).toBe('ready')
    const exited = once(child, 'exit')
    await server.shutdown()
    expect(await exited).toEqual([null, 'SIGTERM'])
    expect(child.rootAbsent).toBe(true)
  })

  it('preserves missing-folder error classification when the host cannot spawn', async () => {
    const child = launch('throw 1', 'one-shot', join(directory, 'missing'))
    const error = new Promise<Error>((resolve) => child.once('error', resolve))
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    await expect(error).resolves.toHaveProperty('code', 'ENOENT')
    await closed
    expect(child.spawnAbsenceKnown).toBe(true)
    expect(child.rootAbsent).toBe(true)
  })

  it('cancels a pending handle without inventing a PID or starting a fallback', async () => {
    let release!: (client: DaemonClient) => void
    const host = new Promise<DaemonClient>((resolve) => {
      release = resolve
    })
    const spec = createProviderSpawnSpec(
      { command: process.execPath, args: ['-e', 'throw 1'], cwd: directory },
      {},
      process.platform
    )
    const child = new HostedProviderChild(
      spec,
      () => host,
      () => {
        throw new Error('Duplicate spawn')
      }
    )
    children.add(child)
    const failure = new Promise<Error>((resolve) => child.once('error', resolve))
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    await expect(
      stopSupervisedChildProcess(child, { site: 'pending-cancel-test' })
    ).resolves.toMatchObject({ root: 'exited' })
    release(client)
    expect(await failure).toHaveProperty('message', 'Provider launch canceled')
    await closed
    expect(child.pid).toBeUndefined()
    expect(child.spawnAbsenceKnown).toBe(true)
    await expect(child.ready).rejects.toThrow('Provider launch canceled')
  })
})

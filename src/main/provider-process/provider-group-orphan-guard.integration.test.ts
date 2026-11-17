import { readPosixProcessRow } from './provider-process-row-read'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProviderSpawnSpec, resolveProviderExecPath } from './provider-process-supervisor'
import { spawnProviderProcess } from './provider-process-spawn'
import { readProviderLeaderOutcome } from './provider-leader-outcome'
import { profileStateAccessBootIdentity } from '../persistence/profile-state/access/profile-state-access-identity'
import {
  proveProviderProcessIdentity,
  sameProviderProcess,
  providerGroupAbsent,
  sweepOrphanedProviderGroup
} from './provider-group-orphan-guard'
import {
  recoverProviderOwnership,
  waitForProviderGroupReap,
  waitForProviderOwnershipReap
} from './provider-ownership-journal'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({
    getPath: () => state.root,
    getAppPath: () => process.cwd(),
    isPackaged: () => false
  })
}))
const cleanups: (() => Promise<void>)[] = []
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'orca-provider-recovery-'))
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  await rm(state.root, { recursive: true, force: true })
})

function track(child: ChildProcess): Promise<void> {
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  cleanups.push(async () => {
    child.kill('SIGKILL')
    await closed
  })
  child.on('error', () => {})
  return closed
}

function outputLine(stream: Readable, predicate: (line: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const done = (): void => {
      clearTimeout(timer)
      stream.off('data', read)
    }
    const read = (chunk: Buffer): void => {
      buffer += chunk.toString()
      let boundary: number
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 1)
        if (predicate(line)) {
          done()
          resolve(line)
          return
        }
      }
    }
    const timer = setTimeout(() => {
      done()
      reject(new Error('Expected provider line did not arrive'))
    }, 15_000)
    stream.on('data', read)
  })
}

async function gatedNative(detachedTool = false) {
  const bootId = profileStateAccessBootIdentity()
  if (!bootId) {
    throw new Error('Missing host boot identity')
  }
  const child = spawn(
    resolveProviderExecPath(),
    [
      '--cli-input-fd7',
      '20',
      '100',
      'session',
      'stdin-end-and-sigterm',
      '--',
      process.execPath,
      '-e',
      String.raw`
      require('node:child_process').spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('EXECUTED' + JSON.stringify({ tool: process.pid }) + '\\n'); setInterval(() => {}, 60000)"
      ], { detached: ${detachedTool}, stdio: ['ignore', 'inherit', 'inherit'] })
      setInterval(() => {}, 60000)
    `
    ],
    {
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe']
    }
  )
  const closed = track(child)
  const outcome = child.stdio.at(6)
  if (!(outcome instanceof Readable)) {
    throw new Error('Missing leader outcome')
  }
  const exited = readProviderLeaderOutcome(outcome)
  const status = child.stdio.at(5)
  const control = child.stdio.at(3)
  if (!(status instanceof Readable) || !(control instanceof Writable) || !child.pid) {
    throw new Error('Missing bootstrap pipes')
  }
  cleanups.push(async () => {
    if (!control.destroyed) {
      control.end()
    }
    child.kill('SIGKILL')
    await closed
  })
  if (control instanceof Readable) {
    control.resume()
  }
  const boot: { leaderPid: number; watcherPid: number } = JSON.parse(
    await outputLine(status, () => true)
  )
  const [leader, watcher] = await Promise.all([
    proveProviderProcessIdentity(boot.leaderPid),
    proveProviderProcessIdentity(boot.watcherPid)
  ])
  if (!leader || !watcher) {
    throw new Error('Could not identify native fixture')
  }
  const identity = { pgid: boot.leaderPid, leader, watcher }
  cleanups.push(async () => {
    await sweepOrphanedProviderGroup(identity)
    await waitForProviderOwnershipReap(identity)
  })
  return { child, closed, exited, boot: { ...boot, bootId }, leader, watcher }
}

describe.runIf(process.platform !== 'win32')('provider orphan ownership', () => {
  it.each(['leader', 'watcher'] as const)(
    'reaps the actual provider group when its %s is SIGKILLed',
    async (target) => {
      const spec = createProviderSpawnSpec(
        {
          command: process.execPath,
          args: [
            '-e',
            String.raw`
      require('node:child_process').spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); process.stdout.write(JSON.stringify({ tool: process.pid }) + '\\n'); setInterval(() => {}, 60000)"
      ], { stdio: ['ignore', 'inherit', 'inherit'] })
      setInterval(() => {}, 60000)
    `
          ]
        },
        process.env,
        process.platform
      )
      const child = spawnProviderProcess(spec)
      child.on('error', () => {})
      child.stderr.resume()
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      cleanups.push(async () => {
        child.kill('SIGKILL')
        await closed
      })
      const ready = await outputLine(child.stdout, (line) => line.startsWith('{'))
      const tool = await readPosixProcessRow(JSON.parse(ready).tool)
      cleanups.push(async () => {
        if (tool && tool !== 'unverifiable') {
          const live = await readPosixProcessRow(tool.pid)
          if (live && live !== 'unverifiable' && sameProviderProcess(tool, live)) {
            process.kill(live.pid, 'SIGKILL')
          }
        }
      })
      const directory = join(state.root, 'provider-processes')
      const [name] = await readdir(directory)
      const record = JSON.parse(await readFile(join(directory, name), 'utf8'))
      process.kill(record[target].pid, 'SIGKILL')
      await closed
      expect(child.signalCode).toBe(target === 'watcher' ? 'SIGTERM' : 'SIGKILL')
      expect(child.groupVerdict).toBe('exited')
      expect(await readdir(directory)).toEqual([])
    }
  )

  it.each(['EOF', 'crash'] as const)('cleans the provider group after owner %s', async (mode) => {
    const helper = resolveProviderExecPath()
    const providerFile = join(state.root, 'provider.cjs')
    await writeFile(
      providerFile,
      String.raw`
      require('node:child_process').spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 60000)"
      ], { stdio: ['ignore', 'inherit', 'inherit'] })
      process.on('SIGTERM', () => {})
      setInterval(() => {}, 60000)
    `
    )
    const owner = spawn(
      process.execPath,
      [
        '-e',
        String.raw`
      const { spawn } = require('node:child_process')
      const child = spawn(process.argv[1], ['--cli-input-fd7', '20', '100', 'session', 'stdin-end-and-sigterm', '--', process.execPath, process.argv[3]],
        { detached: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] })
      child.stdout.pipe(process.stdout)
      child.stderr.pipe(process.stderr)
      child.stdio[3].resume()
      child.stdio[6].resume()
      let status = ''
      child.stdio[5].on('data', chunk => {
        status += chunk
        if (!status.includes('\n')) return
        const boot = JSON.parse(status.split('\n')[0])
        require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ pgid: boot.leaderPid, ...boot }))
        child.stdio[4].end('g\n')
      })
      child.on('error', error => { throw error })
      process.stdin.resume().once('end', () => child.stdio[3].end())
    `,
        helper,
        join(state.root, 'owner-record.json'),
        providerFile
      ],
      { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const ownerClosed = track(owner)
    owner.stderr?.resume()
    if (!owner.stdout) {
      throw new Error('Missing owner output')
    }
    await outputLine(owner.stdout, (line) => line === 'ready')
    const record = JSON.parse(await readFile(join(state.root, 'owner-record.json'), 'utf8'))
    cleanups.push(async () => {
      owner.kill('SIGKILL')
      try {
        process.kill(-record.pgid, 'SIGKILL')
      } catch {}
      await ownerClosed
    })
    if (mode === 'crash') {
      owner.kill('SIGKILL')
    } else {
      owner.stdin?.end()
    }
    await ownerClosed
    expect(await waitForProviderGroupReap(record.pgid)).toBe(true)
  })

  it.each(['leaderless group', 'stalled CLI with detached tools'])(
    'recovers a dead owner’s %s before allowing the next CLI to execute',
    async (mode) => {
      const gated = await gatedNative(mode === 'stalled CLI with detached tools')
      const deadOwner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
        stdio: 'ignore'
      })
      const deadClosed = track(deadOwner)
      if (!deadOwner.pid) {
        throw new Error('Missing owner PID')
      }
      const owner = await proveProviderProcessIdentity(deadOwner.pid)
      if (!owner) {
        throw new Error('Missing owner identity')
      }
      deadOwner.kill('SIGKILL')
      await deadClosed
      const directory = join(state.root, 'provider-processes')
      await mkdir(directory, { mode: 0o700 })
      const recordPath = join(directory, `${randomUUID()}.json`)
      await writeFile(
        recordPath,
        JSON.stringify({
          version: 1,
          nonce: randomUUID(),
          hostname: 'before-network-change',
          statePath: directory,
          bootId: gated.boot.bootId,
          owner,
          leader: gated.leader,
          watcher: gated.watcher,
          pgid: gated.leader.pid
        }),
        { mode: 0o600 }
      )
      const gate = gated.child.stdio.at(4)
      if (!(gate instanceof Writable)) {
        throw new Error('Missing execution gate')
      }
      const executed = outputLine(gated.child.stdout!, (line) => line.startsWith('EXECUTED'))
      gate.end('g\n')
      const toolPid = JSON.parse((await executed).slice('EXECUTED'.length)).tool
      const tool = await proveProviderProcessIdentity(toolPid)
      if (!tool) {
        throw new Error('Missing tool identity')
      }
      cleanups.push(async () => {
        const live = await readPosixProcessRow(tool.pid)
        if (live && live !== 'unverifiable' && sameProviderProcess(tool, live)) {
          process.kill(tool.pid, 'SIGKILL')
        }
      })
      process.kill(gated.watcher.pid, 'SIGSTOP')
      if (mode === 'leaderless group') {
        process.kill(gated.leader.pid, 'SIGKILL')
        await gated.exited
      } else {
        process.kill(gated.leader.pid, 'SIGSTOP')
      }
      expect(providerGroupAbsent(gated.leader.pid)).toBe(false)

      const spec = createProviderSpawnSpec(
        {
          command: process.execPath,
          args: [
            '-e',
            String.raw`
      try { process.kill(-Number(process.argv[1]), 0); process.stdout.write('group still alive\n') }
      catch (error) { process.stdout.write(error.code + '\n') }
    `,
            '--',
            String(gated.leader.pid)
          ]
        },
        process.env,
        process.platform,
        { lifetime: 'one-shot' }
      )
      const child = spawnProviderProcess(spec)
      child.on('error', () => {})
      child.stderr.resume()
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      cleanups.push(async () => {
        child.kill('SIGKILL')
        await closed
      })
      expect(await outputLine(child.stdout, () => true)).toBe('ESRCH')
      await expect.poll(() => readPosixProcessRow(tool.pid)).toBeNull()
      await Promise.all([closed, gated.closed])
      expect(providerGroupAbsent(gated.leader.pid)).toBe(true)
      await expect.poll(() => readPosixProcessRow(gated.watcher.pid)).toBeNull()
      expect(child.groupVerdict).toBe('exited')
      expect(await readdir(directory)).toEqual([])
    }
  )

  it('preserves live-owner and refused records without signaling their group', async () => {
    const gated = await gatedNative()
    const owner = await proveProviderProcessIdentity(process.pid)
    if (!owner) {
      throw new Error('Missing test owner')
    }
    const directory = join(state.root, 'provider-processes')
    await mkdir(directory, { mode: 0o700 })
    const base = {
      version: 1,
      hostname: hostname(),
      statePath: directory,
      bootId: gated.boot.bootId,
      owner,
      leader: gated.leader,
      watcher: gated.watcher,
      pgid: gated.leader.pid
    }
    await writeFile(
      join(directory, 'live.json'),
      JSON.stringify({ ...base, nonce: randomUUID() }),
      { mode: 0o600 }
    )
    await writeFile(
      join(directory, 'refused.json'),
      JSON.stringify({
        ...base,
        nonce: randomUUID(),
        owner: { ...owner, startedAt: 'old-owner' },
        leader: { ...gated.leader, startedAt: 'reused' },
        watcher: { ...gated.watcher, startedAt: 'reused' }
      }),
      { mode: 0o600 }
    )
    await recoverProviderOwnership(directory, gated.boot.bootId)
    expect(providerGroupAbsent(gated.leader.pid)).toBe(false)
    expect((await readdir(directory)).sort()).toEqual(['live.json', 'refused.json'])
  })
})

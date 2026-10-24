import * as files from 'node:fs/promises'
import * as processRows from './provider-process-row-read'
import * as ledger from './provider-process-ledger'
import * as managedProcesses from './managed-provider-process'
import * as auth from '../rate-limits/codex-auth-presence'
import * as backend from '../rate-limits/codex-backend-usage-client'
import { fetchCodexRateLimits } from '../rate-limits/codex-fetcher'
import { ProviderCleanupBudget } from './provider-process-exit-deadline'
import {
  providerLedgerStates,
  runProviderRecovery,
  setProviderRecoveryMutationOwner
} from './provider-process-inventory'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { getAppEnvironment, setAppEnvironment } from '../../shared/app-environment'
import {
  resolveCodexHomeProcessLockKey,
  withCodexHomeProcessLock
} from '../codex-cli/codex-home-process-lock'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof files>())
}))

const roots: string[] = []
const children: ReturnType<typeof spawnProcess>[] = []
afterEach(async () => {
  // Every PID is returned by this test's launch; never select processes by a pattern.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  await Promise.all(roots.splice(0).map((root) => files.rm(root, { recursive: true, force: true })))
})

async function folder(): Promise<string> {
  const root = await files.mkdtemp(join(tmpdir(), 'nc-perf-direct-'))
  roots.push(root)
  return root
}

async function readWhenWritten(path: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const text = await files.readFile(path, 'utf8').catch(() => '')
    if (text) {
      return text
    }
    await delay(25)
  }
  throw new Error(`fixture did not write ${path}`)
}

async function expectHomeBlocked(home: string, message: string): Promise<void> {
  await expect(withCodexHomeProcessLock(home, async () => 'unsafe')).rejects.toThrow(message)
}

async function expectOtherHomeAvailable(home: string): Promise<void> {
  await expect(withCodexHomeProcessLock(`${home}-other`, async () => 'other')).resolves.toBe(
    'other'
  )
}

describe.runIf(process.platform !== 'win32')('direct provider ownership', () => {
  it('keeps the actual parent, final output and status while reaping inherited group pipes', async () => {
    const root = await folder()
    const toolFile = join(root, 'tool-pid')
    const script = `
      const {spawn}=require('node:child_process');
      const tool=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},60000)'],{stdio:['ignore',1,2]});
      require('node:fs').writeFileSync(process.argv[1],String(tool.pid));
      process.stdout.write(JSON.stringify({pid:process.pid,parent:process.ppid})+'\\n');
      setTimeout(()=>{process.stdout.write('final-record\\n');process.exit(7)},150);
    `
    const managed = managedProcesses.spawnManagedProviderProcess(
      { command: process.execPath, args: ['-e', script, toolFile] },
      { site: 'direct-test' }
    )
    children.push(managed.child)
    let output = ''
    managed.child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    const physical = vi.fn()
    managed.onExit(physical)
    const toolPid = Number(await readWhenWritten(toolFile))
    try {
      const exit = await managed.completion
      expect(exit).toEqual({ code: 7, signal: null, processless: false })
      expect(physical).toHaveBeenCalledOnce()
      expect(JSON.parse(output.split('\n')[0] ?? '')).toEqual({
        pid: managed.child.pid,
        parent: process.pid
      })
      expect(output).toContain('final-record\n')
      expect(await processRows.readPosixProcessRow(toolPid)).toBeNull()
      expect(await managed.verifyWriters()).toBe('released')
      const reap = vi.fn(async () => 'exited' as const)
      await managed.close({ capture: async () => {}, reap, treeVerdict: 'exited' })
      expect(reap).toHaveBeenCalledOnce()
    } finally {
      // Exact fixture PID, recorded before the assertion that might fail.
      try {
        process.kill(toolPid, 'SIGKILL')
      } catch {
        /* Already reaped. */
      }
      await managed.close()
    }
  })

  it('shares normal close, escalates a TERM-ignoring group, and preserves user Node environment', async () => {
    const managed = managedProcesses.spawnManagedProviderProcess(
      {
        command: process.execPath,
        args: [
          '-e',
          'process.on("SIGTERM",()=>{});process.stdout.write(JSON.stringify({options:process.env.NODE_OPTIONS,electron:process.env.ELECTRON_RUN_AS_NODE}));setInterval(()=>{},60000)'
        ]
      },
      {
        site: 'direct-close-test',
        resource: { kind: 'codex-home', key: `direct-close-${randomUUID()}` },
        inheritedEnv: { ...process.env, NODE_OPTIONS: '--no-warnings', ELECTRON_RUN_AS_NODE: '1' }
      }
    )
    children.push(managed.child)
    const output = await new Promise<string>((resolve) =>
      managed.child.stdout.once('data', (chunk) => resolve(String(chunk)))
    )
    expect(JSON.parse(output)).toEqual({ options: '--no-warnings' })
    const [one, two, writersGone] = await Promise.all([
      managed.close(),
      managed.close(),
      managed.verifyWriters(new ProviderCleanupBudget())
    ])
    expect(one).toMatchObject({ root: 'exited', tree: 'exited' })
    expect(two).toEqual(one)
    expect(writersGone).toBe('released')
    expect(await managed.completion).toMatchObject({ signal: 'SIGKILL' })
  })

  it('recovers recorded disposable members, skips live owners and refuses changed identity', async () => {
    const root = await folder()
    const directory = join(root, 'provider-processes')
    await files.mkdir(directory)
    const saved = getAppEnvironment()
    setAppEnvironment({
      ...saved,
      getPath: (key) => (key === 'userData' ? root : saved.getPath(key))
    })
    const spawnFixture = (): ReturnType<typeof spawnProcess> => {
      const child = spawnProcess({
        program: process.execPath,
        args: ['-e', 'setInterval(()=>{},60000)'],
        detached: true
      })
      child.stdout.resume()
      child.stderr.resume()
      children.push(child)
      return child
    }
    const stale = spawnFixture(),
      live = spawnFixture(),
      changed = spawnFixture()
    try {
      // Darwin lstart identities must predate the scan's second.
      await delay(1_100)
      const owner = await processRows.readPosixProcessRow(process.pid)
      if (!owner || owner === 'unverifiable') {
        throw new Error('test owner identity unreadable')
      }
      const record = async (
        child: ReturnType<typeof spawnFixture>,
        liveOwner: boolean,
        mismatch: boolean
      ): Promise<void> => {
        if (!child.pid) {
          throw new Error('test child did not spawn')
        }
        const member = await processRows.readPosixProcessRow(child.pid)
        if (!member || member === 'unverifiable') {
          throw new Error('test member identity unreadable')
        }
        const token = randomUUID()
        await files.writeFile(
          join(directory, `${token}.json`),
          JSON.stringify({
            version: 1,
            origin: 'direct',
            token,
            directory,
            createdAt: Date.now(),
            pgid: child.pid,
            owner: liveOwner ? owner : { pid: 9_999_999, pgid: 9_999_999, startedAt: 'gone' },
            members: [{ ...member, ...(mismatch ? { startedAt: 'changed' } : {}) }]
          })
        )
      }
      await record(stale, false, false)
      await record(live, true, false)
      await record(changed, false, true)
      await ledger.recoverProviderLaunches()
      expect(stale.exitCode !== null || stale.signalCode !== null).toBe(true)
      expect(live.exitCode).toBeNull()
      expect(live.signalCode).toBeNull()
      expect(changed.exitCode).toBeNull()
      expect(changed.signalCode).toBeNull()
    } finally {
      setAppEnvironment(saved)
    }
  })
})

it.runIf(process.platform !== 'win32')(
  'keeps a captured refresh writer excluded after its wrapper exits and its group changes',
  async () => {
    const root = await folder()
    const writerFile = join(root, 'writer-pid')
    const escapedFile = join(root, 'escaped')
    const toolFile = join(root, 'tool-pid')
    const python = [
      'import os, sys, time',
      `open(${JSON.stringify(writerFile)}, 'w').write(str(os.getpid()))`,
      'sys.stdin.readline()',
      'os.setsid()',
      `open(${JSON.stringify(escapedFile)}, 'w').write('ready')`,
      'time.sleep(60)'
    ].join('\n')
    const home = resolveCodexHomeProcessLockKey(join(root, 'home'))
    const recorded = vi.spyOn(ledger, 'recordProviderLaunch')
    const managed = managedProcesses.spawnManagedProviderProcess(
      {
        command: process.execPath,
        args: [
          '-e',
          `
    const writer=require('node:child_process').spawn('/usr/bin/python3',['-c',${JSON.stringify(python)}],{stdio:['pipe','inherit','inherit']});
    let tool;
    process.stdin.on('data',chunk=>{
      if(String(chunk).trim()==='tool'){
        tool=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{stdio:'ignore'});
        require('node:fs').writeFileSync(${JSON.stringify(toolFile)},String(tool.pid));
      } else if(String(chunk).trim()==='retire') tool.kill('SIGKILL');
      else writer.stdin.write(chunk);
    });
    setInterval(()=>{},60000);
  `
        ]
      },
      { site: 'escaped-writer-test', resource: { kind: 'codex-home', key: home } }
    )
    children.push(managed.child)
    const record = recorded.mock.results[0]!.value
    managed.child.stdout.resume()
    const writerPid = Number(await readWhenWritten(writerFile))
    await delay(1_100)
    const publication = Promise.withResolvers<void>()
    const slots = Promise.withResolvers<void>()
    const issued: Promise<unknown>[] = []
    const mkdir = vi.spyOn(files, 'mkdir')
    const held =
      Promise.withResolvers<Awaited<ReturnType<typeof processRows.readPosixProcessRow>>>()
    const original = processRows.readPosixProcessRow
    let unavailable = false
    let holding = false
    try {
      await record.capture()
      expect(record.members().some((member) => member.pid === writerPid)).toBe(true)
      for (let batch = 0; batch < 2; batch++) {
        await files.rm(toolFile, { force: true })
        managed.child.stdin.write('tool\n')
        const toolPid = Number(await readWhenWritten(toolFile))
        await delay(1_100)
        await record.capture()
        expect(record.members().some((member) => member.pid === toolPid)).toBe(true)
        managed.child.stdin.write('retire\n')
        await vi.waitFor(async () =>
          expect(await processRows.readPosixProcessRow(toolPid)).toBeNull()
        )
        await record.capture()
        expect(
          record
            .members()
            .map((member) => member.pid)
            .sort()
        ).toEqual([managed.child.pid, writerPid].sort())
        const entry = providerLedgerStates().find(
          ({ entry }) => entry.pgid === managed.child.pid
        )!.entry
        const persisted = JSON.parse(
          await files.readFile(join(entry.directory, `${entry.token}.json`), 'utf8')
        )
        expect(persisted.members).toEqual(record.members())
      }
      managed.child.stdin.write('escape\n')
      await readWhenWritten(escapedFile)
      mkdir.mockImplementationOnce(() => publication.promise.then(() => undefined))
      expect(await managed.close()).toMatchObject({ root: 'exited', tree: 'exited' })
      await expectHomeBlocked(home, 'still using this account home')
      await expectOtherHomeAvailable(home)
      vi.spyOn(auth, 'probeCodexAuthPresence').mockResolvedValue('present')
      const fallback = vi.spyOn(backend, 'fetchCodexRateLimitsViaBackend').mockResolvedValue(null)
      const spawn = vi.spyOn(managedProcesses, 'spawnManagedProviderProcess')
      const rows = vi
        .spyOn(processRows, 'readPosixProcessRow')
        .mockImplementation((pid, ...args) => {
          if (pid === writerPid && holding) {
            return held.promise
          }
          return pid === writerPid && unavailable
            ? Promise.resolve('unverifiable' as const)
            : original(pid, ...args)
        })
      const refusal = async (error: string) => {
        const result = await fetchCodexRateLimits({ codexHomePath: home })
        expect(result).toMatchObject({ status: 'error', error })
        expect(spawn).not.toHaveBeenCalled()
        await expectOtherHomeAvailable(home)
        return result
      }
      await refusal(
        'Codex is still using this account home. Try again after its previous command stops.'
      )
      unavailable = true
      const message = 'Orca could not verify previous Codex processes. Try again.'
      const unknown = await refusal(message)
      const success = { ...unknown, status: 'ok' as const, error: null }
      fallback.mockResolvedValueOnce(success)
      await expect(fetchCodexRateLimits({ codexHomePath: home })).resolves.toEqual(success)
      expect(spawn).not.toHaveBeenCalled()
      const episode = providerLedgerStates().find(({ entry }) => entry.resource?.key === home)
      const since = episode?.entry.unknownSince?.resource
      const signals = vi.spyOn(process, 'kill')
      holding = true
      const started = Date.now()
      await refusal(message)
      expect(Date.now() - started).toBeLessThan(8_000)
      holding = false
      held.resolve('unverifiable')
      await refusal(message)
      expect(episode?.entry.unknownSince?.resource).toBe(since)
      expect(episode?.entry.resource?.key).toBe(home)
      expect(signals).not.toHaveBeenCalled()
      rows.mockRestore()
      process.kill(writerPid, 'SIGKILL')
      await vi.waitFor(async () =>
        expect(await processRows.readPosixProcessRow(writerPid)).toBeNull()
      )
      issued.push(
        ...Array.from({ length: 4 }, () =>
          runProviderRecovery(
            { tail: Promise.resolve() },
            new ProviderCleanupBudget(),
            () => slots.promise
          )
        )
      )
      await expect(withCodexHomeProcessLock(home, async () => 'safe')).resolves.toBe('safe')
      expect(record.members()).toEqual([])
      slots.resolve()
      await Promise.all(issued)
      publication.resolve()
    } finally {
      holding = false
      held.resolve('unverifiable')
      publication.resolve()
      slots.resolve()
      await Promise.all(issued)
      await record.capture()
      recorded.mockRestore()
      mkdir.mockRestore()
      try {
        process.kill(writerPid, 'SIGKILL')
      } catch {
        /* Already gone. */
      }
      await managed.close()
      vi.restoreAllMocks()
    }
  }
)

it.runIf(process.platform !== 'win32')(
  'hands over old resource-only writers, retries unreadable inventory and discharges zombies without signals',
  async () => {
    const root = await folder()
    const directory = join(root, 'provider-processes')
    await files.mkdir(directory)
    const token = randomUUID(),
      home = `restart-${token}`,
      path = join(directory, `${token}.json`)
    const owner = { pid: 9_999_998, pgid: 9_999_998, startedAt: 'owner' }
    const member = { pid: 9_999_999, pgid: 9_999_999, startedAt: '2026-10-01T00:00:00.000Z' }
    const late = { ...member, pid: member.pid - 2 }
    await files.writeFile(
      path,
      JSON.stringify({
        version: 1,
        origin: 'direct',
        token,
        directory,
        createdAt: Date.now() - 8 * 86400000,
        owner,
        pgid: member.pgid,
        members: [member],
        groupRetired: true,
        resource: { kind: 'codex-home', key: home }
      })
    )
    const saved = getAppEnvironment()
    const environment: typeof saved = {
      ...saved,
      getPath: (key) => (key === 'userData' ? root : saved.getPath(key))
    }
    setAppEnvironment(environment)
    setProviderRecoveryMutationOwner(true)
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('no signals permitted')
    })
    let state: 'live' | 'unknown' | 'zombie' = 'live'
    let capturing = true,
      failFinal = true
    const rows = vi.spyOn(processRows, 'readPosixProcessRow').mockImplementation(async (pid) => {
      if (pid === owner.pid) {
        if (capturing) {
          const current = JSON.parse(await realRead(path, 'utf8'))
          await files.writeFile(path, JSON.stringify({ ...current, members: [member, late] }))
          capturing = false
        }
        return null
      }
      return pid !== late.pid
        ? null
        : state === 'unknown'
          ? 'unverifiable'
          : {
              ...late,
              ppid: 1,
              pgid: member.pgid + 1,
              startResolution: 'clock-tick',
              zombie: state === 'zombie'
            }
    })
    const realRead = files.readFile
    const listing = vi
      .spyOn(files, 'readdir')
      .mockRejectedValueOnce(Object.assign(new Error('inventory denied'), { code: 'EACCES' }))
    const read = vi
      .spyOn(files, 'readFile')
      .mockRejectedValueOnce(Object.assign(new Error('unreadable'), { code: 'EACCES' }))
    try {
      await expectHomeBlocked(home, 'could not verify')
      listing.mockRestore()
      await expectHomeBlocked(home, 'could not verify')
      read.mockRejectedValueOnce(
        Object.assign(new Error('removed after listing'), { code: 'ENOENT' })
      )
      await expectOtherHomeAvailable(home)
      setAppEnvironment(saved)
      providerLedgerStates()
      setAppEnvironment(environment)
      read.mockImplementation(async (...args) => {
        if (!capturing && failFinal && args[0] === path) {
          throw Object.assign(new Error('final snapshot unavailable'), { code: 'EACCES' })
        }
        return realRead(...args)
      })
      await ledger.recoverProviderLaunches()
      const published = await realRead(path, 'utf8')
      await expectHomeBlocked(home, 'could not verify')
      expect(await realRead(path, 'utf8')).toBe(published)
      failFinal = false
      await expectHomeBlocked(home, 'still using')
      await expectOtherHomeAvailable(home)
      expect(JSON.parse(await realRead(path, 'utf8')).unknownSince.resource).toBeUndefined()
      state = 'unknown'
      await expectHomeBlocked(home, 'could not verify')
      const anchor = JSON.parse(await realRead(path, 'utf8')).unknownSince.resource
      await expectHomeBlocked(home, 'could not verify')
      expect(JSON.parse(await realRead(path, 'utf8')).unknownSince.resource).toBe(anchor)
      state = 'zombie'
      await expect(withCodexHomeProcessLock(home, async () => 'safe')).resolves.toBe('safe')
      await expect(realRead(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(signal).not.toHaveBeenCalled()
    } finally {
      rows.mockRestore()
      signal.mockRestore()
      listing.mockRestore()
      read.mockRestore()
      setProviderRecoveryMutationOwner(false)
      setAppEnvironment(saved)
    }
  }
)

it('bounds shared recovery capacity and cancels queued cleanup without late work', async () => {
  const gate = Promise.withResolvers<void>()
  const started: number[] = []
  const flights = Array.from({ length: 5 }, (_, index) =>
    runProviderRecovery(
      { tail: Promise.resolve() },
      new ProviderCleanupBudget(Date.now() + 30),
      async () => {
        started.push(index)
        await gate.promise
      }
    )
  )
  await Promise.all(flights)
  expect(started).toEqual([0, 1, 2, 3])
  gate.resolve()
  await delay(10)
  expect(started).toEqual([0, 1, 2, 3])
})

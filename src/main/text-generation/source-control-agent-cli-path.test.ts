import * as fs from 'node:fs'
import * as asyncFs from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import * as processHost from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
const { runProcess } = processHost
import { installedNamingHomeContract } from './source-control-agent-cli-home.test-fixture'
import { discoverModelsLocal } from './commit-message-model-discovery'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProviderSpawnSpec,
  INSTALLED_LOOKUP_REQUEST,
  POSIX_PROVIDER_SUPERVISOR_SCRIPT
} from '../provider-process/provider-process-supervisor'
import { supervisedProviderSpawnFailure } from '../provider-process/provider-spawn-failure-report'
import { generateConversationNameFromContext } from './commit-message-text-generation'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { runLocalSourceControlPlan } from './source-control-local-process'
import { cancelLocalGeneration } from './source-control-generation-lanes'
import {
  installedNamingScalingContract,
  type AttemptEvent
} from './source-control-agent-cli-scaling.test-fixture'
import {
  _setGuestWindowsDriveMountsForTests,
  oneShotGuestPathPolicy
} from '../ipc/wsl-guest-windows-drive-path'

const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} = fs
const fixture = vi.hoisted(() => {
  function initialHold(): { entered: () => void; gate: Promise<void> } | null {
    return null
  }
  function initialAdvisoryBoundary(): {
    command: string
    beforeOpen?: () => void | Promise<void>
    afterOpen?: (file: asyncFs.FileHandle) => void | Promise<void>
  } | null {
    return null
  }
  return {
    preload: '',
    children: new Array<ChildProcess>(),
    specs: new Array<ProcessSpec>(),
    messages: new Array<unknown>(),
    handles: new Array<asyncFs.FileHandle>(),
    hold: initialHold(),
    advisoryBoundary: initialAdvisoryBoundary()
  }
})
vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof processHost>()
  return {
    ...actual,
    spawnProcess: (spec: ProcessSpec) => {
      const supervised = spec.args?.[1] === POSIX_PROVIDER_SUPERVISOR_SCRIPT
      const child = actual.spawnProcess(
        supervised && fixture.preload
          ? {
              ...spec,
              env: { ...spec.env, ORCA_TEST_ATTEMPTS: `${fixture.preload}.events` },
              args: ['--require', fixture.preload, ...(spec.args ?? [])]
            }
          : spec
      )
      if (supervised) {
        fixture.specs.push(spec)
        fixture.children.push(child)
        const observe = (message: unknown): void => {
          fixture.messages.push(message)
        }
        child.on('message', observe)
        child.once('disconnect', () => child.off('message', observe))
      }
      return child
    }
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    readdirSync: vi.fn(actual.readdirSync),
    openSync: vi.fn(actual.openSync)
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof asyncFs>()
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    access: vi.fn(actual.access),
    readFile: vi.fn(actual.readFile),
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const boundary = fixture.advisoryBoundary
      if (String(args[0]) === boundary?.command) {
        await boundary.beforeOpen?.()
      }
      const file = await actual.open(...args)
      vi.spyOn(file, 'stat')
      vi.spyOn(file, 'read')
      vi.spyOn(file, 'close')
      fixture.handles.push(file)
      if (String(args[0]) === boundary?.command) {
        await boundary.afterOpen?.(file)
      }
      return file
    }),
    readdir: vi.fn(async (...args: Parameters<typeof actual.readdir>) => {
      if (fixture.hold && String(args[0]).endsWith('/.nvm/versions/node')) {
        fixture.hold.entered()
        await fixture.hold.gate
      }
      return actual.readdir(...args)
    })
  }
})

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-naming-cli-'))
  vi.stubEnv('HOME', root)
  fixture.children = []
  fixture.specs = []
  fixture.messages = []
  fixture.handles = []
  fixture.hold = null
  fixture.advisoryBoundary = null
  vi.mocked(asyncFs.stat).mockClear()
  vi.mocked(asyncFs.open).mockClear()
  vi.mocked(asyncFs.access).mockClear()
  vi.mocked(asyncFs.readFile).mockClear()
  vi.mocked(fs.statSync).mockClear()
  vi.mocked(fs.readdirSync).mockClear()
  vi.mocked(fs.openSync).mockClear()
  vi.mocked(asyncFs.readdir).mockClear()
  fixture.preload = join(root, 'observe.cjs')
  writeFileSync(
    fixture.preload,
    `
const cp = require('node:child_process'), fs = require('node:fs')
const spawn = cp.spawn
const record = (event) => fs.appendFileSync(process.env.ORCA_TEST_ATTEMPTS, JSON.stringify(event) + '\\n')
process.on('message', (plan) => record({ plan }))
cp.spawn = (command, ...args) => {
  record({ attempt: command })
  let child
  try { child = spawn(command, ...args) } catch (error) { record({ failed: command, code: error.code }); throw error }
  if (child.pid) record({ started: command, pid: child.pid })
  child.on('error', (error) => record({ failed: command, code: error.code }))
  child.on('close', () => {
    record({ closed: command })
    if (process.env.ORCA_TEST_CANCEL_BETWEEN === command) process.kill(process.pid, 'SIGTERM')
  })
  return child
}
`
  )
})
afterEach(async () => {
  for (const child of fixture.children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve))
      child.kill('SIGTERM')
      await closed
    }
  }
  fixture.hold = null
  _setGuestWindowsDriveMountsForTests(null)
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('installed one-shot naming CLI', () => {
  it.each(['absolute PATH', 'relative PATH', 'symlink cwd'])(
    'preserves the original supervisor executable with %s containing symlink/..',
    async (input) => {
      mkdirSync(join(root, 'actual', 'nested'), { recursive: true })
      mkdirSync(join(root, 'actual', 'bin'))
      mkdirSync(join(root, 'bin'))
      symlinkSync(join(root, 'actual', 'nested'), join(root, 'link'))
      writeFileSync(join(root, 'actual', 'bin', 'cx'), '#!/bin/sh\necho Fix login flow\n', {
        mode: 0o755
      })
      writeFileSync(join(root, 'bin', 'cx'), '#!/bin/sh\necho Different executable\n', {
        mode: 0o755
      })
      const cwd = input === 'symlink cwd' ? join(root, 'link') : root
      // Keep the traversal literal: lexical normalization changes which executable runs.
      const pathEnv =
        input === 'absolute PATH'
          ? `${root}/link/../bin`
          : input === 'relative PATH'
            ? 'link/../bin'
            : '../bin'
      const env = { PATH: pathEnv }
      const original = await runProcess({
        ...createProviderSpawnSpec({ command: 'cx', args: [], cwd }, env, process.platform, {
          lifetime: 'one-shot'
        }),
        timeoutMs: 5000
      })
      expect(original).toMatchObject({ code: 0, stdout: 'Fix login flow\n', timedOut: false })
      await expect(
        generateConversationNameFromContext(
          { firstPrompt: 'Fix login' },
          { agentId: 'custom', model: '', customAgentCommand: 'cx' },
          { kind: 'local', cwd, env }
        )
      ).resolves.toMatchObject({ success: true, name: original.stdout.trim() })
    }
  )

  installedNamingScalingContract(() => root, fixture, readEvents, lookupMessage)
  installedNamingHomeContract(() => root, fixture, readEvents)
})

function readEvents(): AttemptEvent[] {
  const path = `${fixture.preload}.events`
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
}
function lookupMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === INSTALLED_LOOKUP_REQUEST
  )
}
function installed(
  version: number,
  command = 'orca-fixture-agent',
  script = '#!/bin/sh\necho Working title\n',
  mode = 0o755
): string {
  const bin = join(root, '.nvm', 'versions', 'node', `v20.${version}.0`, 'bin')
  mkdirSync(bin, { recursive: true })
  const path = join(bin, command)
  writeFileSync(path, script, { mode })
  return path
}
async function makeFifo(path: string): Promise<void> {
  const made = await runProcess({ program: '/usr/bin/mkfifo', args: [path], timeoutMs: 5000 })
  expect(made.code).toBe(0)
}
function onPath(directory: string, script: string, mode = 0o755): string {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'orca-fixture-agent')
  writeFileSync(path, script, { mode })
  return path
}
function name(
  command = 'orca-fixture-agent',
  path = join(root, 'absent'),
  extra: NodeJS.ProcessEnv = {},
  cwd = root
) {
  return generateConversationNameFromContext(
    { firstPrompt: 'Fix login' },
    { agentId: 'custom', model: '', customAgentCommand: command },
    { kind: 'local', cwd, env: { PATH: path, ...extra } }
  )
}
function holdInventory() {
  let resume!: () => void
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  fixture.hold = { entered, gate }
  return { ready, resume }
}

describe.skipIf(process.platform === 'win32')('exec-authoritative naming and settlement', () => {
  it.each(['missing interpreter', 'denied'])(
    'keeps the same-host raw winner after an earlier %s on PATH',
    async (failure) => {
      const a = join(root, 'a'),
        b = join(root, 'b')
      onPath(
        a,
        failure === 'denied'
          ? '#!/bin/sh\necho Wrong title\n'
          : '#!/nonexistent/orca-interpreter\n',
        failure === 'denied' ? 0o644 : 0o755
      )
      onPath(b, '#!/bin/sh\necho Working title\n')
      const env = { PATH: `${a}:${b}` }
      const raw = await runProcess({
        ...createProviderSpawnSpec(
          { command: 'orca-fixture-agent', args: [], cwd: root },
          env,
          process.platform,
          { lifetime: 'one-shot' }
        ),
        timeoutMs: 5000
      })
      expect(raw).toMatchObject({ code: 0, stdout: 'Working title\n' })
      await expect(name(undefined, env.PATH)).resolves.toMatchObject({
        success: true,
        name: raw.stdout.trim()
      })
      expect(fixture.messages.some(lookupMessage)).toBe(false)
      expect(asyncFs.readdir).not.toHaveBeenCalled()
    }
  )
  it.each(['denied', 'exit127', 'env failure', 'format'])(
    'preserves a terminal raw %s even with a usable installed copy',
    async (failure) => {
      installed(1)
      const path = join(root, 'path')
      const script =
        failure === 'denied'
          ? '#!/bin/sh\necho Wrong title\n'
          : failure === 'exit127'
            ? '#!/bin/sh\nexit 127\n'
            : failure === 'env failure'
              ? '#!/usr/bin/env orca-nonexistent-interpreter\n'
              : 'echo Format title\n'
      onPath(path, script, failure === 'denied' ? 0o644 : 0o755)
      const raw = await runProcess({
        ...createProviderSpawnSpec(
          { command: 'orca-fixture-agent', args: [], cwd: root },
          { PATH: path },
          process.platform,
          { lifetime: 'one-shot' }
        ),
        timeoutMs: 5000
      })
      const result = await name(undefined, path)
      expect(result.success).toBe(raw.code === 0)
      if (raw.code === 0) {
        expect(result).toMatchObject({ name: raw.stdout.trim() })
      } else {
        const failed = supervisedProviderSpawnFailure(raw.code, raw.stderr)
        if (failed) {
          expect(result).toMatchObject({
            error: expect.stringContaining(
              failed.thrown ? 'could not be started' : 'failed to start'
            )
          })
        }
      }
      expect(asyncFs.readdir).not.toHaveBeenCalled()
      expect(fixture.messages.some(lookupMessage)).toBe(false)
      expect(readEvents().filter((event) => event.attempt)).toHaveLength(1)
    }
  )
  it.each(['missing interpreter', 'denied', 'missing entry'])(
    'settles an installed %s before executing the later candidate',
    async (failure) => {
      const first = installed(
        2,
        undefined,
        failure === 'missing interpreter'
          ? '#!/nonexistent/orca-interpreter\n'
          : '#!/bin/sh\necho Wrong title\n',
        failure === 'denied' ? 0o644 : 0o755
      )
      if (failure === 'missing entry') {
        unlinkSync(first)
      }
      const last = installed(1)
      await expect(name()).resolves.toMatchObject({ success: true, name: 'Working title' })
      const events = readEvents()
      expect(events.filter((event) => event.attempt).map((event) => event.attempt)).toEqual([
        'orca-fixture-agent',
        first,
        last
      ])
      expect(events.findIndex((event) => event.closed === first)).toBeLessThan(
        events.findIndex((event) => event.attempt === last)
      )
      expect(events.filter((event) => event.started)).toEqual([
        expect.objectContaining({ started: last })
      ])
      expect(fixture.specs).toHaveLength(1)
      expect(fixture.messages.filter(lookupMessage)).toHaveLength(1)
    }
  )
  it.each(['missing', 'denied', 'FIFO', 'format', 'literal'])(
    'terminates %s exhaustion or host terminal failure without replay',
    async (failure) => {
      const sentinel = join(root, 'sentinel')
      const first = installed(
        2,
        undefined,
        failure === 'denied'
          ? '#!/bin/sh\n'
          : failure === 'format'
            ? 'exit 23\n'
            : '#!/nonexistent/orca-interpreter\n',
        failure === 'denied' ? 0o644 : 0o755
      )
      if (failure === 'FIFO') {
        unlinkSync(first)
        await makeFifo(first)
        symlinkSync(process.execPath, join(first, '..', 'node'))
      }
      if (failure === 'format' || failure === 'literal') {
        installed(1, undefined, `#!/bin/sh\necho ran > '${sentinel}'\necho Wrong title\n`)
      }
      const result = await name(failure === 'literal' ? `"${first}"` : undefined)
      expect(result.success).toBe(false)
      if (failure === 'denied' || failure === 'FIFO') {
        expect(result).toMatchObject({ error: expect.stringContaining('failed to start') })
        expect(readEvents()).toContainEqual({ failed: first, code: 'EACCES' })
      }
      if (failure === 'missing' || failure === 'literal') {
        expect(result).toMatchObject({ error: expect.stringContaining('not found on PATH') })
      }
      expect(existsSync(sentinel)).toBe(false)
      expect(readEvents().filter((event) => event.started).length).toBeLessThanOrEqual(1)
      expect(fixture.specs).toHaveLength(1)
      expect(fixture.messages.filter(lookupMessage)).toHaveLength(failure === 'literal' ? 0 : 1)
    }
  )
  it.each(['FIFO', 'symlink', 'swap before open', 'swap after open'])(
    'executes every candidate after advisory inspection of %s without a writer',
    async (kind) => {
      const first = installed(2)
      const last = installed(1)
      symlinkSync(process.execPath, join(first, '..', 'node'))
      const fifo = join(root, 'unwritten-fifo')
      await makeFifo(fifo)
      const replaceWithFifo = (): void => {
        unlinkSync(first)
        symlinkSync(fifo, first)
      }
      if (kind === 'FIFO') {
        unlinkSync(first)
        await makeFifo(first)
      } else if (kind !== 'swap before open') {
        replaceWithFifo()
      }
      fixture.advisoryBoundary = {
        command: first,
        beforeOpen: kind === 'swap before open' ? replaceWithFifo : undefined,
        afterOpen:
          kind === 'swap after open'
            ? () => {
                unlinkSync(first)
                writeFileSync(first, '#!/bin/sh\necho Forbidden title\n', { mode: 0o644 })
              }
            : undefined
      }
      let results = 0
      const result = name().then((value) => {
        results++
        return value
      })
      await expect(result).resolves.toMatchObject({ success: true, name: 'Working title' })
      const child = fixture.children[0]
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => child.once('close', resolve))
      }
      const events = readEvents()
      expect(events.filter((event) => event.attempt).map((event) => event.attempt)).toEqual([
        'orca-fixture-agent',
        first,
        last
      ])
      expect(events).toContainEqual({ failed: first, code: 'EACCES' })
      expect(events.filter((event) => event.started)).toEqual([
        expect.objectContaining({ started: last })
      ])
      expect(events.find((event) => event.plan)?.plan?.candidates).toContainEqual({
        command: first,
        runtimeDirectory: join(first, '..')
      })
      expect(results).toBe(1)
      expect(fixture.children).toHaveLength(1)
      expect(fixture.messages.filter(lookupMessage)).toHaveLength(1)
      expect(
        fixture.messages.filter(
          (message) => typeof message === 'object' && message !== null && 'pgid' in message
        )
      ).toHaveLength(1)
      expect(fixture.handles).toHaveLength(1)
      const file = fixture.handles[0]
      expect(file.read).not.toHaveBeenCalled()
      expect(file.stat).toHaveBeenCalledTimes(1)
      expect((await vi.mocked(file.stat).mock.results[0].value).isFIFO()).toBe(true)
      expect(file.close).toHaveBeenCalledTimes(1)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(process.getActiveResourcesInfo()).not.toContain('FSReqPromise')
      expect(child.listenerCount('message')).toBe(0)
    }
  )
  it.each(['stat', 'read'] as const)(
    'closes an acquired handle after advisory %s failure',
    async (operation) => {
      const first = installed(2, undefined, '#!/nonexistent/orca-interpreter\n')
      installed(1)
      symlinkSync(process.execPath, join(first, '..', 'node'))
      fixture.advisoryBoundary = {
        command: first,
        afterOpen: (file) => {
          vi.mocked(file[operation]).mockRejectedValueOnce(new Error('advisory I/O failure'))
        }
      }
      await expect(name()).resolves.toMatchObject({ success: true, name: 'Working title' })
      expect(fixture.handles[0][operation]).toHaveBeenCalledTimes(1)
      expect(fixture.handles[0].close).toHaveBeenCalledTimes(1)
      expect(readEvents().find((event) => event.plan)?.plan?.candidates).toContainEqual({
        command: first,
        runtimeDirectory: join(first, '..')
      })
    }
  )
  it('closes a FIFO acquired before cancellation without sending a stale plan', async () => {
    const first = installed(2)
    installed(1)
    unlinkSync(first)
    await makeFifo(first)
    symlinkSync(process.execPath, join(first, '..', 'node'))
    let release!: () => void
    let acquired!: () => void
    const ready = new Promise<void>((resolve) => {
      acquired = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fixture.advisoryBoundary = {
      command: first,
      afterOpen: async () => {
        acquired()
        await gate
      }
    }
    const execution = runLocalSourceControlPlan({
      plan: { binary: 'orca-fixture-agent', args: [], stdinPayload: 'prompt', label: 'Fixture' },
      operation: 'conversation-name',
      cwd: root,
      env: { PATH: join(root, 'absent') },
      spawnAgent: spawnSourceControlAgent
    })
    let results = 0
    void execution.result.then(() => results++)
    await ready
    const child = fixture.children[0]
    const send = vi.spyOn(child, 'send')
    cancelLocalGeneration('conversation-name', root)
    await expect(execution.result).resolves.toMatchObject({ canceled: true })
    await execution.processClosed
    release()
    await vi.waitFor(() => expect(fixture.handles[0].close).toHaveBeenCalledTimes(1))
    expect(fixture.handles[0].read).not.toHaveBeenCalled()
    expect(results).toBe(1)
    expect(send).not.toHaveBeenCalled()
    expect(readEvents().filter((event) => event.attempt)).toEqual([
      { attempt: 'orca-fixture-agent' }
    ])
    expect(child.listenerCount('message')).toBe(0)
    expect(process.getActiveResourcesInfo()).not.toContain('FSReqPromise')
  })
  it('captures a relative launch cwd once for raw execution', async () => {
    onPath(root, '#!/bin/sh\necho Working title\n')
    await expect(name(undefined, '', {}, relative(process.cwd(), root))).resolves.toMatchObject({
      success: true,
      name: 'Working title'
    })
  })
  it.each(['bin', '', ':missing', 'missing:', 'bin '])(
    'leaves raw cwd PATH %j literal',
    async (path) => {
      const dir = path === 'bin ' ? 'bin ' : path === 'bin' ? 'bin' : ''
      onPath(join(root, dir), '#!/bin/sh\necho Working title\n')
      await expect(name(undefined, path)).resolves.toMatchObject({
        success: true,
        name: 'Working title'
      })
      expect(asyncFs.readdir).not.toHaveBeenCalled()
    }
  )
  it('pairs only installed runtime while preserving raw PATH bytes, argv and account env', async () => {
    const program = installed(
      1,
      undefined,
      `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.OBSERVED, JSON.stringify({path:process.env.PATH,args:process.argv.slice(2),home:process.env.CODEX_HOME,deleted:process.env.DELETED}))
process.stdin.resume().on('end', () => console.log('Working title'))
`
    )
    symlinkSync(process.execPath, join(program, '..', 'node'))
    const conflict = join(root, 'conflict')
    mkdirSync(conflict)
    writeFileSync(join(conflict, 'node'), '#!/bin/sh\necho Wrong runtime\nexit 9\n', {
      mode: 0o755
    })
    const path = `${conflict}:missing:: relative :/usr/bin:/bin`
    const observed = join(root, 'observed')
    await expect(
      name('orca-fixture-agent --account chosen', path, {
        OBSERVED: observed,
        CODEX_HOME: '/account/only',
        DELETED: undefined
      })
    ).resolves.toMatchObject({ success: true })
    expect(JSON.parse(readFileSync(observed, 'utf8'))).toMatchObject({
      path: `${join(program, '..')}:${path}`,
      args: ['--account', 'chosen'],
      home: '/account/only'
    })
    expect(readFileSync(observed, 'utf8')).not.toContain('deleted')
  })
  it.each(['wake', 'cancel', 'between attempts'])(
    'settles the production loop after a delayed real inventory: %s',
    async (action) => {
      const first = installed(2, undefined, '#!/nonexistent/orca-interpreter\n')
      const program = installed(
        1,
        undefined,
        `#!${process.execPath}
const {createHash}=require('node:crypto')
const hash=createHash('sha256');let length=0
process.stdin.on('data',b=>{hash.update(b);length+=b.length}).on('end',()=>console.log(length+':'+hash.digest('hex')))
`
      )
      const payload = 'prompt\n'.repeat(50000)
      const hold = holdInventory()
      const execution = runLocalSourceControlPlan({
        plan: { binary: 'orca-fixture-agent', args: [], stdinPayload: payload, label: 'Fixture' },
        operation: 'conversation-name',
        cwd: root,
        env: {
          PATH: join(root, 'absent'),
          ...(action === 'between attempts' ? { ORCA_TEST_CANCEL_BETWEEN: first } : {})
        },
        spawnAgent: spawnSourceControlAgent
      })
      let results = 0
      void execution.result.then(() => results++)
      await hold.ready
      expect(readEvents().filter((event) => event.attempt)).toHaveLength(1)
      const send = vi.spyOn(fixture.children[0], 'send')
      if (action === 'cancel') {
        cancelLocalGeneration('conversation-name', root)
        await expect(execution.result).resolves.toMatchObject({ canceled: true })
        await execution.processClosed
        hold.resume()
        // Let the real pending read finish; a terminal handler must not send its plan.
        await Promise.all(vi.mocked(asyncFs.readdir).mock.results.map((result) => result.value))
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(send).not.toHaveBeenCalled()
      } else {
        hold.resume()
        const result = await execution.result
        await execution.processClosed
        if (action === 'wake') {
          const { createHash } = await import('node:crypto')
          expect(result).toMatchObject({
            success: true,
            rawOutput: `${Buffer.byteLength(payload)}:${createHash('sha256').update(payload).digest('hex')}`
          })
          expect(readEvents().filter((event) => event.started)).toEqual([
            expect.objectContaining({ started: program })
          ])
          expect(send).toHaveBeenCalledTimes(1)
        } else {
          expect(result.success).toBe(false)
          expect(readEvents().some((event) => event.started)).toBe(false)
        }
      }
      expect(results).toBe(1)
      expect(fixture.specs).toHaveLength(1)
      expect(fixture.children[0].listenerCount('message')).toBe(0)
    }
  )
  it('cancels pending Codex inventory and permits the next generation on its home lock', async () => {
    const program = installed(1, 'codex')
    const hold = holdInventory()
    const request = () =>
      generateConversationNameFromContext(
        { firstPrompt: 'Fix login' },
        { agentId: 'codex', model: 'gpt-5.5' },
        {
          kind: 'local',
          cwd: root,
          env: { PATH: join(root, 'absent'), CODEX_HOME: join(root, '.codex') }
        }
      )
    const first = request()
    await hold.ready
    cancelLocalGeneration('conversation-name', root)
    await expect(first).resolves.toMatchObject({ canceled: true })
    const closed =
      fixture.children[0].exitCode !== null || fixture.children[0].signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => fixture.children[0].once('close', resolve))
    await closed
    hold.resume()
    fixture.hold = null
    await expect(request()).resolves.toMatchObject({ success: true, name: 'Working title' })
    expect(readEvents().filter((event) => event.started)).toEqual([
      expect.objectContaining({ started: program })
    ])
  })
  it.each(['', 'bin', '/drive/npm'])(
    'uses the guest sentinel for all-excluded raw PATH %j at a mounted cwd',
    async (component) => {
      const drive = join(root, 'drive')
      const cwd = join(drive, 'workspace')
      onPath(cwd, '#!/bin/sh\necho Forbidden title\n')
      onPath(join(cwd, 'bin'), '#!/bin/sh\necho Forbidden title\n')
      installed(1)
      _setGuestWindowsDriveMountsForTests([drive, '/drive'])
      await expect(name(undefined, component, {}, cwd)).resolves.toMatchObject({
        success: true,
        name: 'Working title'
      })
      expect(fixture.specs[0].env?.PATH).toBe('/proc/orca-agent-cli-installed-only-on-windows')
      expect(readEvents().some((event) => event.attempt?.startsWith(drive))).toBe(false)
    }
  )
  it.each(['home', 'inventory', 'alias', 'candidate', 'runtime'])(
    'rejects mounted %s reads before access',
    async (kind) => {
      const program = installed(1)
      symlinkSync(process.execPath, join(program, '..', 'node'))
      const mount =
        kind === 'home'
          ? root
          : kind === 'inventory'
            ? join(root, '.nvm')
            : kind === 'alias'
              ? join(root, '.nvm', 'alias')
              : kind === 'candidate'
                ? program
                : join(program, '..', 'node')
      _setGuestWindowsDriveMountsForTests([mount])
      const result = await name()
      expect(result.success).toBe(kind === 'alias' || kind === 'runtime')
      expect(
        [
          ...vi.mocked(asyncFs.readdir).mock.calls,
          ...vi.mocked(asyncFs.stat).mock.calls,
          ...vi.mocked(asyncFs.access).mock.calls,
          ...vi.mocked(asyncFs.open).mock.calls,
          ...vi.mocked(asyncFs.readFile).mock.calls
        ].some(([path]) => String(path).startsWith(mount))
      ).toBe(false)
      const policy = oneShotGuestPathPolicy(root, [])
      const env = { PATH: 'bin:: odd :/mnt/c' }
      expect(policy.spawnEnv(env)).toBe(env)
      expect(policy.filterPath(env.PATH)).toBe(env.PATH)
    }
  )
  it('uses actual process cwd for model discovery and retains its missing-CLI error mapping', async () => {
    const request = (path: string) =>
      discoverModelsLocal({
        agentId: 'opencode',
        env: { PATH: path },
        agentCommandOverride: 'orca-fixture-agent',
        options: { cwd: root },
        backslash: 'escape',
        spawnAgent: spawnSourceControlAgent
      })
    await expect(request(join(root, 'absent'))).resolves.toMatchObject({
      success: false,
      unavailable: { reason: 'cliMissing' }
    })
    const observed = join(root, 'discovery-cwd')
    onPath(root, `#!/bin/sh\npwd > '${observed}'\necho vendor/model\n`)
    await expect(request(relative(process.cwd(), root))).resolves.toMatchObject({
      success: true,
      models: expect.arrayContaining([expect.objectContaining({ id: 'vendor/model' })])
    })
    expect(readFileSync(observed, 'utf8').trim()).toBe(process.cwd())
    expect(fixture.specs.every((spec) => spec.cwd === process.cwd())).toBe(true)
  })
})

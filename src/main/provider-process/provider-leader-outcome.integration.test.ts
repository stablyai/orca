import { readPosixProcessRow, type ProcessRowRead } from './provider-process-row-read'
import { sameProviderProcess } from './provider-group-orphan-guard'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess, spawnProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnManagedProviderProcess } from './managed-provider-process'
import { spawnCodexAppServerConnection } from '../codex/app-server/codex-app-server-connection'
import {
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor
} from '../codex/structured/session-lifecycle/codex-structured-session-adapter-fixture'
import type { CodexStructuredSessionEvent } from '../codex/structured/session-lifecycle/codex-structured-session-state'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({
    getPath: () => state.root,
    getAppPath: () => process.cwd(),
    isPackaged: () => false
  })
}))

const cleanups: (() => Promise<void>)[] = []

async function expectNotRunning(pids: number[]): Promise<void> {
  for (const pid of pids) {
    const status = await runProcess({
      program: 'ps',
      args: ['-o', 'stat=', '-p', String(pid)],
      timeoutMs: 2_000
    })
    expect(status.timedOut).toBe(false)
    expect(status.code === 0 || status.code === 1).toBe(true)
    // A non-reaping init may retain a zombie after H dies; it is no longer running.
    expect(status.stdout.trim(), `pid ${pid}`).toMatch(/^(Z\S*)?$/)
  }
}

async function recordedWatcherPid(): Promise<number> {
  const directory = join(state.root, 'provider-processes')
  const [name] = await readdir(directory)
  return JSON.parse(await readFile(join(directory, name), 'utf8')).watcher.pid
}

// The CLI's tool leads its own session, outside every group signal.
function cliWithDetachedTool(onStop: string): string {
  return String.raw`
    const tool = require('node:child_process').spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 60000)"
    ], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const stop = (reason) => { ${onStop} }
    process.stdin.on('end', () => stop('stdin-end')).resume()
    process.on('SIGTERM', () => stop('sigterm'))
    tool.stdout.once('data', () => process.stdout.write(JSON.stringify({ tool: tool.pid }) + '\n'))
    setInterval(() => {}, 60000)
  `
}

function spawnCliWithTool(onStop: string) {
  let parent: ChildProcess | undefined
  let toolIdentity: ProcessRowRead = null
  const managed = spawnManagedProviderProcess(
    { command: process.execPath, cwd: state.root, args: ['-e', cliWithDetachedTool(onStop)] },
    {
      site: 'native-parent-transport-loss-test',
      inheritedEnv: process.env,
      spawnImpl: (spec) => {
        parent = spawnProcess(spec)
        return parent
      }
    }
  )
  const lines: string[] = []
  managed.child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    lines.push(...chunk.split('\n').filter(Boolean))
  })
  const exits: unknown[] = []
  managed.onExit((status) => exits.push(status))
  const closed = new Promise<void>((resolve) => managed.child.once('close', () => resolve()))
  cleanups.push(async () => {
    managed.child.kill('SIGKILL')
    await closed
    if (toolIdentity && toolIdentity !== 'unverifiable') {
      const live = await readPosixProcessRow(toolIdentity.pid)
      if (live && live !== 'unverifiable' && sameProviderProcess(toolIdentity, live)) {
        process.kill(live.pid, 'SIGKILL')
      }
    }
  })
  const started = (async () => {
    await once(managed.child.stdout, 'data')
    await managed.child.ready
    const toolPid: number = JSON.parse(lines[0]).tool
    const leaderPid = managed.child.pid
    if (!parent?.pid || !leaderPid || !toolPid) {
      throw new Error('Missing native fixture')
    }
    toolIdentity = await readPosixProcessRow(toolPid)
    const parentExited = once(parent, 'exit')
    return { parentPid: parent.pid, leaderPid, toolPid, parentExited }
  })()
  return { managed, lines, exits, closed, started }
}

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'orca-provider-outcome-'))
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  await rm(state.root, { recursive: true, force: true })
})

describe.runIf(process.platform !== 'win32')('native parent outcome loss', () => {
  it('retires a cleaned CLI group after parent death without inventing a CLI outcome or spawn error', async () => {
    let parent: ChildProcess | undefined
    const managed = spawnManagedProviderProcess(
      {
        command: process.execPath,
        cwd: state.root,
        args: [
          '-e',
          String.raw`
          const descendant = require('node:child_process').spawn(process.execPath, ['-e',
            "process.stdout.write('ready'); setInterval(() => {}, 60000)"
          ], { stdio: ['ignore', 'pipe', 'inherit'] })
          descendant.stdout.once('data', () => {
            process.stderr.write('retained stderr\n')
            process.stdout.write(JSON.stringify({
              leader: process.pid, parent: process.ppid, descendant: descendant.pid
            }) + '\n')
          })
          setInterval(() => {}, 60000)
        `
        ]
      },
      {
        site: 'native-parent-outcome-loss-test',
        inheritedEnv: process.env,
        spawnImpl: (spec) => {
          parent = spawnProcess(spec)
          return parent
        }
      }
    )
    const errors: Error[] = []
    const exits: unknown[] = []
    const managedExits: unknown[] = []
    managed.child.on('error', (error) => errors.push(error))
    managed.child.on('exit', (...status) => exits.push(status))
    managed.onExit((status) => managedExits.push(status))
    const closed = new Promise<unknown[]>((resolve) => {
      managed.child.once('close', (...status) => resolve(status))
    })
    cleanups.push(async () => {
      managed.child.kill('SIGKILL')
      await closed
    })
    const [chunk] = await once(managed.child.stdout, 'data')
    const identity = JSON.parse(chunk.toString())
    await managed.child.ready
    if (!parent?.pid) {
      throw new Error('Missing native parent')
    }
    const rawParent = parent
    expect(identity.parent).toBe(rawParent.pid)
    expect(identity.leader).toBe(managed.child.pid)
    expect(identity.leader).not.toBe(rawParent.pid)
    expect(() => process.kill(identity.leader, 0)).not.toThrow()
    expect(() => process.kill(identity.descendant, 0)).not.toThrow()
    const parentExited = new Promise<unknown[]>((resolve) => {
      rawParent.once('exit', (...status) => resolve(status))
    })
    rawParent.kill('SIGKILL')
    await expect(parentExited).resolves.toEqual([null, 'SIGKILL'])
    await expect(closed).resolves.toEqual([null, null])
    expect(errors).toEqual([])
    expect(
      exits,
      JSON.stringify({
        group: managed.child.groupVerdict,
        exited: managed.child.leaderExited,
        killed: managed.child.killed
      })
    ).toEqual([[null, null]])
    expect(managedExits).toEqual([
      { code: null, signal: null, processless: false, outcomeLost: true }
    ])
    expect(managed.child.exitCode).toBeNull()
    expect(managed.child.signalCode).toBeNull()
    expect(managed.child.leaderExited).toBe(true)
    expect(managed.exitStatus).toEqual({
      code: null,
      signal: null,
      processless: false,
      outcomeLost: true
    })
    expect(managed.rootExitObserved).toBe(false)
    expect(managed.rootVerdict).toBe('exited')
    await expect(managed.close()).resolves.toMatchObject({ root: 'exited' })
    await expect(managed.close()).resolves.toMatchObject({ root: 'exited' })
    expect(managed.processless).toBe(false)
    expect(managed.stderrTail()).toBe('retained stderr\n')
    await expectNotRunning([identity.leader, identity.descendant])
  })

  it.each([
    { lost: 'parent', exit: { code: null, signal: null, processless: false, outcomeLost: true } },
    { lost: 'watcher', exit: { code: 0, signal: null, processless: false } }
  ] as const)(
    'preserves a cooperative CLI outcome and cleans its detached tool after losing its $lost',
    async ({ lost, exit }) => {
      const run = spawnCliWithTool(
        "try { process.kill(tool.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }; process.exit(0)"
      )
      const { parentPid, leaderPid, toolPid } = await run.started
      process.kill(lost === 'parent' ? parentPid : await recordedWatcherPid(), 'SIGKILL')
      await run.closed
      await expectNotRunning([leaderPid, toolPid])
      expect(run.exits).toEqual([exit])
    }
  )

  it.each(['parent', 'watcher'] as const)(
    'reaps a hung CLI and its detached tool after losing its %s',
    async (lost) => {
      const run = spawnCliWithTool("process.stdout.write(reason + '\\n')")
      const { parentPid, leaderPid, toolPid } = await run.started
      process.kill(lost === 'parent' ? parentPid : await recordedWatcherPid(), 'SIGKILL')
      await run.closed
      await expectNotRunning([leaderPid, toolPid])
      expect(run.lines.slice(1)).toEqual(['stdin-end', 'sigterm'])
      expect(run.exits).toEqual([
        lost === 'parent'
          ? { code: null, signal: null, processless: false, outcomeLost: true }
          : { code: null, signal: 'SIGKILL', processless: false }
      ])
      expect(run.managed.child.groupVerdict).toBe('exited')
    }
  )

  it('keeps stdin cleanup alive when H is lost and then W is lost', async () => {
    const run = spawnCliWithTool(
      "if (reason === 'stdin-end') setTimeout(() => { process.stdout.write('cleaned\\n'); process.exit(0) }, 700)"
    )
    const { parentPid, leaderPid, toolPid, parentExited } = await run.started
    const watcherPid = await recordedWatcherPid()
    process.kill(parentPid, 'SIGKILL')
    await parentExited
    process.kill(watcherPid, 'SIGKILL')
    await run.closed
    await expectNotRunning([leaderPid, toolPid])
    expect(run.lines.slice(1)).toEqual(['cleaned'])
    expect(run.exits).toEqual([{ code: null, signal: null, processless: false, outcomeLost: true }])
  })

  it('delivers TERM if W dies before acting on the queued TERM request', async () => {
    const run = spawnCliWithTool(
      "if (reason === 'sigterm') { process.stdout.write('term-cleanup\\n'); process.exit(0) }"
    )
    const { leaderPid, toolPid } = await run.started
    const watcherPid = await recordedWatcherPid()
    process.kill(watcherPid, 'SIGSTOP')
    run.managed.child.kill('SIGTERM')
    process.kill(watcherPid, 'SIGKILL')
    await run.closed
    await expectNotRunning([leaderPid, toolPid])
    expect(run.lines.slice(1)).toEqual(['term-cleanup'])
    expect(run.exits).toEqual([{ code: 0, signal: null, processless: false }])
  })

  it.each([
    { command: 'process.exit(17)', code: 17, signal: null },
    { command: "process.kill(process.pid, 'SIGTERM')", code: null, signal: 'SIGTERM' }
  ])('preserves the real CLI outcome $code/$signal', async ({ command, code, signal }) => {
    const managed = spawnManagedProviderProcess(
      {
        command: process.execPath,
        cwd: state.root,
        args: [
          '-e',
          `process.stdout.write('ready'); process.stdin.once('data', () => { ${command} })`
        ]
      },
      { site: 'native-parent-known-outcome-test', inheritedEnv: process.env }
    )
    const closed = new Promise<void>((resolve) => managed.child.once('close', () => resolve()))
    cleanups.push(async () => {
      managed.child.kill('SIGKILL')
      await closed
    })
    await once(managed.child.stdout, 'data')
    await managed.child.ready
    managed.child.stdin.write('exit\n')
    await closed
    expect(managed.exitStatus).toEqual({ code, signal, processless: false })
    expect(managed.rootExitObserved).toBe(true)
  })

  it('reports exactly one host fault through the real Codex adapter after losing the parent outcome', async () => {
    let parent: ChildProcess | undefined
    let parentClosed: Promise<void> | undefined
    const events: CodexStructuredSessionEvent[] = []
    const ended = Promise.withResolvers<void>()
    const adapter = adapterFor(
      fakeCodex(),
      {
        command: process.execPath,
        cwd: state.root,
        args: [
          '-e',
          String.raw`
        require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
          const frame = JSON.parse(line)
          if (frame.id !== undefined) {
            process.stdout.write(JSON.stringify({ id: frame.id, result: {
              thread: { id: 'thread-abc', turns: [] }, model: 'gpt-live', reasoningEffort: 'medium'
            } }) + '\n')
          }
        })
      `
        ]
      },
      events,
      {
        openConnection: (launch, handlers) =>
          spawnCodexAppServerConnection(launch, handlers, (spec) => {
            const child = spawnProcess(spec)
            parent = child
            parentClosed = new Promise<void>((resolve) => child.once('close', () => resolve()))
            return child
          }),
        onEvent: (event) => {
          if (event.type === 'ended') {
            ended.resolve()
          }
        }
      }
    )
    cleanups.push(async () => {
      await adapter.closeAll()
      await parentClosed
    })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 's'
    })
    if (!parent?.pid) {
      throw new Error('Missing native parent')
    }
    parent.kill('SIGKILL')
    await ended.promise
    await parentClosed
    expect(events.filter((event) => event.type === 'ended')).toMatchObject([
      { cause: 'unexpected-exit', failure: { kind: 'hostFault' } }
    ])
  })
})

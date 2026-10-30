import { ChildProcess, type SpawnOptions } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'
import { PassThrough } from 'node:stream'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRestTestRig, type RestTestRig } from './structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER as CALLER
} from './structured-agent-session-create-test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { attachFingerprintFields } from './structured-agent-session-attach'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import {
  adoptedDirectoryProbes,
  ADOPTED_DIRECTORY_PROBE_SOURCE
} from '../agent-session-journal/adopted-directory-probe'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcessModule>()),
  spawn
}))

class ProbeChild extends ChildProcess {
  override pid = 1234
  override kill = vi.fn(() => true)
  override stdin = new PassThrough()
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  reply(matched = true) {
    this.stdout.write(JSON.stringify({ version: 1, matched }))
    this.emit('close', 0, null)
  }
}
let rig: RestTestRig
const children: ProbeChild[] = []
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  spawn.mockImplementation((_program: string, _args: string[], _options: SpawnOptions) => {
    const child = new ProbeChild()
    children.push(child)
    return child
  })
})
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.emit('close', null, 'SIGKILL')
  }
  vi.useRealTimers()
  await rig.dispose()
  vi.restoreAllMocks()
  spawn.mockReset()
  expect(adoptedDirectoryProbes.ownedCount).toBe(0)
})
async function request() {
  const transcriptPath = join(rig.root, `${THREAD}.jsonl`)
  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: 'user',
      uuid: 'turn',
      sessionId: THREAD,
      cwd: '/physical/source',
      message: { role: 'user', content: 'original context' }
    })}\n`
  )
  return createTestParams(undefined, {
    agent: 'claude',
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: rig.root },
    adopt: {
      providerHandle: claudeProviderHandle(THREAD, null),
      transcriptPath,
      source: { providerSessionId: THREAD, workspaceCwd: '/selected/workspace' }
    }
  })
}
async function dispatched() {
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
  return children.at(-1)!
}
function uncommitted() {
  expect(rig.store.listRecords()).toEqual([])
  expect(rig.store.listOperationRows()).toEqual([])
  expect(rig.host.collaboratorsForTests().sessions.size).toBe(0)
}

it('settles a deadline once, retains an unexited child, ignores late proof and permits fresh success/replay', async () => {
  const params = await request()
  const publishTab = vi.fn(async () => {})
  const { runtimeState } = rig.host.collaboratorsForTests()
  const tracked = vi.spyOn(StructuredAgentSessionTaskQueue.prototype, 'trackAttach')
  const begin = vi.spyOn(runtimeState.acquireAborts, 'begin')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let settlements = 0
  const first = rig.host.create(CALLER, params, { publishTab }).then((value) => {
    settlements++
    return value
  })
  const child = await dispatched()
  const tasks = tracked.mock.contexts[0]
  if (!(tasks instanceof StructuredAgentSessionTaskQueue)) {
    throw new Error('Create must register its actual attach task')
  }
  expect(tasks.hasPendingAttach(SESSION)).toBe(true)
  const [program, args, options] = spawn.mock.calls[0]
  expect(program).toBe(process.execPath)
  expect(args).toEqual(['-e', ADOPTED_DIRECTORY_PROBE_SOURCE])
  expect(options).toMatchObject({
    cwd: dirname(process.execPath),
    shell: false,
    windowsHide: true,
    env: { ELECTRON_RUN_AS_NODE: '1' }
  })
  expect(options.env.NODE_OPTIONS).toBeUndefined()
  expect(child.stdin.read()?.toString()).toBe(
    JSON.stringify({
      version: 1,
      workspaceCwd: '/selected/workspace',
      sourceCwd: '/physical/source'
    })
  )
  await vi.advanceTimersByTimeAsync(7_000)
  expect(await first).toMatchObject({
    ok: false,
    refusal: { createAttemptRefusedBeforeCommit: true }
  })
  expect(settlements).toBe(1)
  expect(tasks.hasPendingAttach(SESSION)).toBe(false)
  runtimeState.acquireAborts.abort(SESSION, 'after timeout')
  expect(begin.mock.results[0].value.signal.aborted).toBe(false)
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  expect(adoptedDirectoryProbes.ownedCount).toBe(1)
  uncommitted()
  child.stdout.write(JSON.stringify({ version: 1, matched: true }))
  await vi.advanceTimersByTimeAsync(0)
  expect(adoptedDirectoryProbes.ownedCount).toBe(1)
  expect(settlements).toBe(1)
  expect(publishTab).not.toHaveBeenCalled()
  expect(spawn).toHaveBeenCalledOnce()
  uncommitted()
  vi.useRealTimers()
  const next = rig.host.create(CALLER, params, { publishTab })
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
  expect(adoptedDirectoryProbes.ownedCount).toBe(2)
  children.at(-1)!.reply()
  expect(await next).toMatchObject({ ok: true })
  expect(publishTab).toHaveBeenCalledOnce()
  expect(adoptedDirectoryProbes.ownedCount).toBe(1)
  child.emit('close', 0, null)
  expect(adoptedDirectoryProbes.ownedCount).toBe(0)
  await rig.host.flushAllStreamedEvents()
  await rig.restart()
  await expect(
    rig.host.create(CALLER, {
      ...params,
      adopt: { providerHandle: claudeProviderHandle(THREAD, null) }
    })
  ).resolves.toMatchObject({ ok: true, replayed: true })
  expect(spawn).toHaveBeenCalledTimes(2)
})

it.each(['create', 'attach'] as const)(
  'shutdown aborts preparation before draining %s; late close releases only process ownership',
  async (method) => {
    const params = await request()
    if (method === 'attach') {
      params.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: SESSION,
        fields: attachFingerprintFields(params)
      })
    }
    const pending = rig.host[method](CALLER, params)
    const child = await dispatched()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const aborts = rig.host.collaboratorsForTests().runtimeState.acquireAborts
    const abortAll = vi.spyOn(aborts, 'abortAll')
    const teardown = rig.host.flushAllStreamedEvents()
    await vi.advanceTimersByTimeAsync(2_000)
    await teardown
    expect(abortAll).toHaveBeenCalledWith('closed by quit')
    expect(await pending).toMatchObject({ ok: false })
    uncommitted()
    expect(adoptedDirectoryProbes.ownedCount).toBe(1)
    child.reply()
    expect(adoptedDirectoryProbes.ownedCount).toBe(0)
    expect(spawn).toHaveBeenCalledOnce()
  }
)

it.each(['no-match', 'read-error', 'spawn-error', 'invalid', 'truncated'] as const)(
  'refuses %s before commit and ends the acquisition handle',
  async (outcome) => {
    const params = await request()
    const begin = vi.spyOn(rig.host.collaboratorsForTests().runtimeState.acquireAborts, 'begin')
    if (outcome === 'spawn-error') {
      spawn.mockImplementationOnce(() => {
        throw new Error('spawn failed')
      })
    }
    const pending = rig.host.create(CALLER, params)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    if (outcome !== 'spawn-error') {
      const child = children.at(-1)!
      if (outcome === 'no-match') {
        child.reply(false)
      } else {
        child.stdout.write(outcome === 'truncated' ? 'x'.repeat(4097) : 'invalid')
        child.emit('close', outcome === 'read-error' ? 1 : 0, null)
      }
    }
    expect(await pending).toMatchObject({
      ok: false,
      refusal: { createAttemptRefusedBeforeCommit: true }
    })
    const handle = begin.mock.results[0].value
    // Ended handles no longer receive a later shutdown abort.
    rig.host.collaboratorsForTests().runtimeState.acquireAborts.abortAll('after settlement')
    expect(handle.signal.aborted).toBe(false)
    uncommitted()
    expect(adoptedDirectoryProbes.ownedCount).toBe(0)
  }
)

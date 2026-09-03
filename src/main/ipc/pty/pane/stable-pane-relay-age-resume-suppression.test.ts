import { describe, expect, it, vi } from 'vitest'
import {
  SSH_SESSION_EXPIRED_ERROR,
  SshPtyAbsentFromRelayError
} from '../../../providers/ssh-pty-errors'
import type { Store } from '../../../persistence'
import type { IPtyProvider, PtySpawnOptions } from '../../../providers/types'
import { spawnForStablePane, type StablePaneOwner } from './stable-owner'

const LEAF = '1b3f2c4d-5e6a-4b7c-8d9e-0f1a2b3c4d5e'
const CONNECTION = 'conn-1'
const PTY_ID = `ssh:${CONNECTION}@@pty-1`
const OWNER: StablePaneOwner = {
  tabId: 'tab-1',
  leafId: LEAF,
  ptyId: PTY_ID,
  hasPersistedBinding: true
}
const BINDING_AGE_MS = 2 * 60 * 60_000

/** Only the lease read matters here; the retirement path is covered by the absence-respawn suite. */
function leaseStore(createdAt: number | undefined): Store {
  return {
    getSshRemotePtyLeases: () =>
      createdAt === undefined
        ? []
        : [
            {
              targetId: CONNECTION,
              ptyId: 'pty-1',
              state: 'detached',
              createdAt,
              updatedAt: createdAt
            }
          ],
    getWorkspaceSession: () => ({}) as never,
    setWorkspaceSession: () => {},
    flushOrThrow: () => {}
  } as unknown as Store
}

function runFallback(options: {
  spawnOptions: PtySpawnOptions
  relayStatus: () => Promise<unknown>
  leaseCreatedAt?: number | undefined
  now?: number
}): {
  run: () => ReturnType<typeof spawnForStablePane>
  spawn: ReturnType<typeof vi.fn>
  requestHostRpc: ReturnType<typeof vi.fn>
} {
  const now = options.now ?? Date.now()
  const spawn = vi
    .fn()
    .mockRejectedValueOnce(new SshPtyAbsentFromRelayError(`${SSH_SESSION_EXPIRED_ERROR}: pty-1`))
    .mockResolvedValueOnce({ id: `ssh:${CONNECTION}@@pty-2`, isReattach: false })
  const requestHostRpc = vi.fn().mockImplementation(() => options.relayStatus())
  return {
    spawn,
    requestHostRpc,
    run: () =>
      spawnForStablePane({
        runtime: undefined,
        store: leaseStore(
          'leaseCreatedAt' in options ? options.leaseCreatedAt : now - BINDING_AGE_MS
        ),
        provider: { spawn, requestHostRpc } as unknown as IPtyProvider,
        spawnOptions: options.spawnOptions,
        owner: OWNER,
        worktreeId: 'worktree-1',
        connectionId: CONNECTION,
        resolveOwner: () => null
      })
  }
}

/** A replacement relay: up 5 minutes against a 2-hour-old binding. */
const youngerRelay = () => Promise.resolve({ uptimeMs: 5 * 60_000, pid: 4242 })
/** The relay that could have owned the binding: up 4 hours. */
const olderRelay = () => Promise.resolve({ uptimeMs: 4 * 60 * 60_000, pid: 4242 })

const RESUME_ARGV: PtySpawnOptions = {
  cols: 80,
  rows: 24,
  command: 'claude --resume abc123',
  commandDelivery: 'provider'
}
const LAUNCH_AGENT: PtySpawnOptions = { cols: 80, rows: 24, launchAgent: 'claude' }
const BARE_COMMAND: PtySpawnOptions = { cols: 80, rows: 24, command: 'npm run dev' }

describe('absence fallback against a relay younger than the binding', () => {
  it('spawns a shell but drops a resume argv the replacement relay never held', async () => {
    const { run, spawn } = runFallback({ spawnOptions: RESUME_ARGV, relayStatus: youngerRelay })

    const { result } = await run()

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1]![0]).toMatchObject({
      command: undefined,
      commandDelivery: undefined
    })
    expect(result.id).toBe(`ssh:${CONNECTION}@@pty-2`)
    expect(result.agentResumeUnavailable).toBe(true)
  })

  it('drops launchAgent rather than starting a second agent over the same worktree', async () => {
    const { run, spawn } = runFallback({ spawnOptions: LAUNCH_AGENT, relayStatus: youngerRelay })

    const { result } = await run()

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1]![0]).toMatchObject({ launchAgent: undefined })
    expect(result.agentResumeUnavailable).toBe(true)
  })

  it('drops a startup command', async () => {
    const { run, spawn } = runFallback({ spawnOptions: BARE_COMMAND, relayStatus: youngerRelay })

    const { result } = await run()

    expect(spawn.mock.calls[1]![0]).toMatchObject({ command: undefined })
    expect(result.agentResumeUnavailable).toBe(true)
  })

  it('never gates the spawn itself — a shell is always produced', async () => {
    for (const spawnOptions of [RESUME_ARGV, LAUNCH_AGENT, BARE_COMMAND]) {
      const { run, spawn } = runFallback({ spawnOptions, relayStatus: youngerRelay })

      const { result } = await run()

      expect(result.id).toBe(`ssh:${CONNECTION}@@pty-2`)
      expect(spawn).toHaveBeenCalledTimes(2)
    }
  })
})

describe('absence fallback when nothing proves the relay was replaced', () => {
  it('replays the resume when the answering relay predates the binding', async () => {
    const { run, spawn } = runFallback({ spawnOptions: RESUME_ARGV, relayStatus: olderRelay })

    const { result } = await run()

    expect(spawn.mock.calls[1]![0]).toMatchObject({ command: 'claude --resume abc123' })
    expect(result.agentResumeUnavailable).toBeUndefined()
  })

  it('replays the resume when relay.status rejects — silence is not a verdict', async () => {
    const { run, spawn } = runFallback({
      spawnOptions: RESUME_ARGV,
      relayStatus: () => Promise.reject(new Error('relay status failed'))
    })

    const { result } = await run()

    expect(spawn.mock.calls[1]![0]).toMatchObject({ command: 'claude --resume abc123' })
    expect(result.agentResumeUnavailable).toBeUndefined()
  })

  it('replays the resume when relay.status answers with a non-object', async () => {
    const { run, spawn } = runFallback({
      spawnOptions: RESUME_ARGV,
      relayStatus: () => Promise.resolve(null)
    })

    const { result } = await run()

    expect(spawn.mock.calls[1]![0]).toMatchObject({ command: 'claude --resume abc123' })
    expect(result.agentResumeUnavailable).toBeUndefined()
  })

  it('replays the resume when relay.status omits uptimeMs', async () => {
    const { run, spawn } = runFallback({
      spawnOptions: RESUME_ARGV,
      relayStatus: () => Promise.resolve({ pid: 4242 })
    })

    const { result } = await run()

    expect(spawn.mock.calls[1]![0]).toMatchObject({ command: 'claude --resume abc123' })
    expect(result.agentResumeUnavailable).toBeUndefined()
  })

  it('replays the resume on a cold restore with no lease to date the binding', async () => {
    const { run, spawn, requestHostRpc } = runFallback({
      spawnOptions: RESUME_ARGV,
      relayStatus: youngerRelay,
      leaseCreatedAt: undefined
    })

    const { result } = await run()

    expect(requestHostRpc).not.toHaveBeenCalled()
    expect(spawn.mock.calls[1]![0]).toMatchObject({ command: 'claude --resume abc123' })
    expect(result.agentResumeUnavailable).toBeUndefined()
  })

  it('replays the resume when the relay is younger only inside the clock slack', async () => {
    // Two independently measured elapsed times; a sub-slack gap is jitter, not a replacement.
    const { run, spawn } = runFallback({
      spawnOptions: RESUME_ARGV,
      relayStatus: () => Promise.resolve({ uptimeMs: BINDING_AGE_MS - 10_000 })
    })

    const { result } = await run()

    expect(spawn.mock.calls[1]![0]).toMatchObject({ command: 'claude --resume abc123' })
    expect(result.agentResumeUnavailable).toBeUndefined()
  })

  it('replays the resume for a provider with no host RPC to ask', async () => {
    const spawn = vi
      .fn()
      .mockRejectedValueOnce(new SshPtyAbsentFromRelayError(`${SSH_SESSION_EXPIRED_ERROR}: pty-1`))
      .mockResolvedValueOnce({ id: `ssh:${CONNECTION}@@pty-2`, isReattach: false })

    const { result } = await spawnForStablePane({
      runtime: undefined,
      store: leaseStore(Date.now() - BINDING_AGE_MS),
      provider: { spawn } as unknown as IPtyProvider,
      spawnOptions: RESUME_ARGV,
      owner: OWNER,
      worktreeId: 'worktree-1',
      connectionId: CONNECTION,
      resolveOwner: () => null
    })

    expect(spawn.mock.calls[1]![0]).toMatchObject({ command: 'claude --resume abc123' })
    expect(result.agentResumeUnavailable).toBeUndefined()
  })

  it('asks nothing at all when the request carried no startup intent', async () => {
    const { run, spawn, requestHostRpc } = runFallback({
      spawnOptions: { cols: 80, rows: 24 },
      relayStatus: youngerRelay
    })

    const { result } = await run()

    expect(requestHostRpc).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(result.agentResumeUnavailable).toBeUndefined()
  })
})

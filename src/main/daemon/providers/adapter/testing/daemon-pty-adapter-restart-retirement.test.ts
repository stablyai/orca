import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { DaemonPtyRouter } from '../../routing/daemon-pty-router'
import { createMockSubprocess } from '../../../pty-subprocess/testing/fake-restart-subprocess'
import { DaemonServer } from '../../../server/daemon-server'
import { getDaemonSocketPath } from '../../../launch/daemon-spawner'
import { getHistorySessionDirName } from '../../../history/storage/history-paths'

let server: DaemonServer | undefined
let dir: string
let adapter: DaemonPtyAdapter | undefined
let subprocess: ReturnType<typeof createMockSubprocess>

class FinalCheckpointOnlyAdapter extends DaemonPtyAdapter {
  protected override scheduleCheckpointTimer(): void {}
}

class AmbiguousKillReplyAdapter extends FinalCheckpointOnlyAdapter {
  loseKillReply(dispatched: Promise<void>): void {
    const request = this.client.request.bind(this.client)
    vi.spyOn(this.client, 'request').mockImplementation(async (...args) => {
      const reply = request(...args)
      if (args[0] !== 'kill') {
        return reply
      }
      void reply.catch(() => {})
      await dispatched
      throw new Error('kill reply lost')
    })
  }
}

async function start(
  Provider = DaemonPtyAdapter,
  { protocolVersion, withHistory = true }: { protocolVersion?: number; withHistory?: boolean } = {}
): Promise<DaemonPtyAdapter> {
  dir = mkdtempSync(join(tmpdir(), 'orca-restart-history-'))
  const socketPath = getDaemonSocketPath(dir)
  const tokenPath = join(dir, 'test.token')
  server = new DaemonServer({
    socketPath,
    tokenPath,
    protocolVersion,
    spawnSubprocess: () => {
      subprocess = createMockSubprocess()
      return subprocess
    }
  })
  await server.start()
  adapter = new Provider({
    socketPath,
    tokenPath,
    protocolVersion,
    ...(withHistory ? { historyPath: join(dir, 'history') } : {})
  })
  return adapter
}

function historyTree(id: string): string {
  return join(dir, 'history', getHistorySessionDirName(id))
}

function checkedRequest(id: string, expectedIncarnationId: string) {
  return { id, expectedIncarnationId, requireNoAgentOwner: false, requireUnattached: false }
}

async function spawn(provider: DaemonPtyAdapter, id = 'checked-close') {
  const result = await provider.spawn({ sessionId: id, cols: 80, rows: 24 })
  if (!result.incarnationId) {
    throw new Error('Expected incarnation')
  }
  return { ...result, incarnationId: result.incarnationId }
}

afterEach(async () => {
  adapter?.dispose()
  await server?.shutdown()
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
  adapter = undefined
  server = undefined
  vi.restoreAllMocks()
})

describe('DaemonPtyAdapter fenced restart retirement', () => {
  it('preserves output before the first periodic checkpoint during fenced retirement', async () => {
    const provider = await start(FinalCheckpointOnlyAdapter)
    const created = await spawn(provider)
    subprocess._simulateData('final restart screen\r\n')

    await expect(
      provider.killFenced({
        ...checkedRequest(created.id, created.incarnationId),
        keepHistory: true
      })
    ).resolves.toEqual({ outcome: 'ended' })

    const checkpoint = JSON.parse(
      readFileSync(join(historyTree(created.id), 'checkpoint.json'), 'utf8')
    )
    expect(checkpoint.snapshotAnsi).toContain('final restart screen')
    expect(provider.getHistoryManager()!.readMeta(created.id)?.endedAt).toBeNull()
  })

  it('restores the latest durable history after a newer checkpoint commits during retirement', async () => {
    const provider = await start(FinalCheckpointOnlyAdapter)
    const created = await spawn(provider)
    const dispatched = Promise.withResolvers<void>()
    vi.mocked(subprocess.forceKill).mockImplementation(() => dispatched.resolve())
    subprocess._simulateData('output before retirement\r\n')
    const stop = provider.killFenced({
      ...checkedRequest(created.id, created.incarnationId),
      keepHistory: true
    })
    try {
      await Promise.race([
        dispatched.promise,
        stop.then(() => {
          throw new Error('retirement did not reach the daemon stop')
        })
      ])
      await expect(
        provider.getHistoryManager()!.checkpoint(created.id, {
          snapshotAnsi: 'later durable output\r\n',
          scrollbackAnsi: '',
          rehydrateSequences: '',
          cwd: dir,
          modes: {
            bracketedPaste: false,
            mouseTracking: false,
            applicationCursor: false,
            alternateScreen: false
          },
          cols: 80,
          rows: 24,
          scrollbackLines: 0
        })
      ).resolves.toBe('committed')
    } finally {
      subprocess._simulateExit(0)
    }
    await expect(stop).resolves.toEqual({ outcome: 'ended' })
    const replacement = await spawn(provider, created.id)
    expect(replacement.coldRestore?.scrollback).toContain('later durable output')
  })

  it('keeps preserving live history after a fenced stop is refused', async () => {
    const provider = await start()
    const created = await spawn(provider)
    const request = { ...checkedRequest(created.id, created.incarnationId), keepHistory: true }

    await expect(provider.killFenced({ ...request, requireUnattached: true })).resolves.toEqual({
      outcome: 'refused',
      reason: 'attached'
    })
    subprocess._simulateData('output after refused restart\r\n')
    await expect(provider.killFenced(request)).resolves.toEqual({ outcome: 'ended' })

    const checkpoint = JSON.parse(
      readFileSync(join(historyTree(created.id), 'checkpoint.json'), 'utf8')
    )
    expect(checkpoint.snapshotAnsi).toContain('output after refused restart')
  })

  it('restores the verified checkpoint after a matching exit follows an ambiguous stop', async () => {
    const provider = await start(AmbiguousKillReplyAdapter)
    const created = await spawn(provider)
    const dispatched = Promise.withResolvers<void>()
    vi.mocked(subprocess.forceKill).mockImplementation(() => dispatched.resolve())
    if (!(provider instanceof AmbiguousKillReplyAdapter)) {
      throw new Error('Expected the ambiguous reply fixture')
    }
    provider.loseKillReply(dispatched.promise)
    subprocess._simulateData('restore after the late exit\r\n')
    await expect(
      provider.killFenced({
        ...checkedRequest(created.id, created.incarnationId),
        keepHistory: true
      })
    ).resolves.toEqual({ outcome: 'refused', reason: 'unverifiable' })
    const exited = Promise.withResolvers<void>()
    const unsubscribe = provider.onExit(({ id, incarnationId }) => {
      if (id === created.id && incarnationId === created.incarnationId) {
        exited.resolve()
      }
    })
    onTestFinished(unsubscribe)
    subprocess._simulateExit(0)
    await exited.promise
    const replacement = await spawn(provider, created.id)
    expect(replacement.coldRestore?.scrollback).toContain('restore after the late exit')
  })

  it('keeps a v62 daemon terminal alive when account restart operations are unsupported', async () => {
    const provider = await start(DaemonPtyAdapter, { protocolVersion: 62, withHistory: false })
    const created = await spawn(provider)
    await expect(
      provider.killFenced({
        ...checkedRequest(created.id, created.incarnationId),
        keepHistory: true
      })
    ).resolves.toEqual({ outcome: 'refused', reason: 'unsupported' })
    await expect(
      provider.spawn({
        sessionId: created.id,
        cols: 80,
        rows: 24,
        requireFreshSession: true
      })
    ).rejects.toThrow('terminal_account_restart_unsupported')
    expect(provider.hasPty(created.id)).toBe(true)
  })

  it('checks for exit without stopping a live terminal when history cannot be captured', async () => {
    const provider = await start(DaemonPtyAdapter, { withHistory: false })
    const created = await spawn(provider)
    await expect(
      provider.killFenced({
        ...checkedRequest(created.id, created.incarnationId),
        keepHistory: true
      })
    ).resolves.toEqual({ outcome: 'refused', reason: 'unverifiable' })
    expect(provider.hasPty(created.id)).toBe(true)
  })

  it('reports a naturally exited session when there is no live history left to checkpoint', async () => {
    const provider = await start()
    const created = await spawn(provider)
    const exit = Promise.withResolvers<void>()
    const unsubscribe = provider.onExit(({ id }) => {
      if (id === created.id) {
        exit.resolve()
      }
    })
    subprocess._simulateExit(0)
    await exit.promise
    unsubscribe()
    await expect(
      provider.killFenced({
        ...checkedRequest(created.id, created.incarnationId),
        keepHistory: true
      })
    ).resolves.toEqual({ outcome: 'already_exited' })
    expect(subprocess.forceKill).not.toHaveBeenCalled()
    expect(existsSync(historyTree(created.id))).toBe(true)
  })

  it.each(['checkpoint', 'kill reply'] as const)(
    'drains a fenced retirement from the %s before checkpointing for quit',
    async (stage) => {
      const id = 'retirement-during-quit'
      const hostStateAtQuit: boolean[] = []
      class ObserveQuitAdapter extends FinalCheckpointOnlyAdapter {
        protected override async checkpointAllSessions(): Promise<void> {
          hostStateAtQuit.push(this.hasPty(id))
          await super.checkpointAllSessions()
        }
      }
      const provider = await start(ObserveQuitAdapter)
      const created = await spawn(provider, id)
      const checkpointStarted = Promise.withResolvers<void>()
      const releaseCheckpoint = Promise.withResolvers<void>()
      const killStarted = Promise.withResolvers<void>()
      if (stage === 'checkpoint') {
        const history = provider.getHistoryManager()!
        const checkpoint = history.checkpoint.bind(history)
        vi.spyOn(history, 'checkpoint').mockImplementationOnce(async (...args) => {
          checkpointStarted.resolve()
          await releaseCheckpoint.promise
          return checkpoint(...args)
        })
      }
      vi.mocked(subprocess.forceKill).mockImplementation(() => killStarted.resolve())
      subprocess._simulateData('final output before quit\r\n')
      const stop = provider.killFenced({
        ...checkedRequest(id, created.incarnationId),
        keepHistory: true
      })
      const stopping = stop.then((result) => {
        throw new Error(`Retirement returned before the held stage: ${JSON.stringify(result)}`)
      })
      let quit: Promise<void> | undefined
      try {
        await Promise.race([
          stage === 'checkpoint' ? checkpointStarted.promise : killStarted.promise,
          stopping
        ])
        quit = provider.disconnectOnly()
        releaseCheckpoint.resolve()
        await Promise.race([killStarted.promise, stopping])
        // The process is still live until the fake subprocess supplies exit proof.
        await new Promise<void>((resolve) => setImmediate(resolve))
      } finally {
        releaseCheckpoint.resolve()
        subprocess._simulateExit(0)
      }
      await expect(stop).resolves.toEqual({ outcome: 'ended' })
      await quit
      expect(hostStateAtQuit).toEqual([false])
    }
  )

  it.each(['endpoint unavailable', 'conflicting inventory'] as const)(
    'refuses to send a fenced stop when %s during the checkpoint',
    async (change) => {
      const current = await start(FinalCheckpointOnlyAdapter)
      const legacy = new DaemonPtyAdapter({
        socketPath: getDaemonSocketPath(dir),
        tokenPath: join(dir, 'test.token')
      })
      vi.spyOn(legacy, 'listProcesses').mockResolvedValue([])
      onTestFinished(() => legacy.dispose())
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })
      const id = 'checkpoint-route'
      const result = await router.spawn({ sessionId: id, cols: 80, rows: 24, isNewSession: true })
      const incarnationId = result.incarnationId!
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const history = current.getHistoryManager()!
      const checkpoint = history.checkpoint.bind(history)
      vi.spyOn(history, 'checkpoint').mockImplementationOnce(async (...args) => {
        entered.resolve()
        await release.promise
        return checkpoint(...args)
      })
      subprocess._simulateData('before route changed\r\n')
      const authorize = vi.fn()
      const stop = router.killFenced(
        { ...checkedRequest(id, incarnationId), keepHistory: true },
        authorize
      )
      try {
        await Promise.race([
          entered.promise,
          stop.then((outcome) => {
            throw new Error(`Stop bypassed the checkpoint: ${JSON.stringify(outcome)}`)
          })
        ])
        if (change === 'endpoint unavailable') {
          vi.spyOn(current, 'listProcesses').mockRejectedValue(new Error('endpoint changed'))
        } else {
          vi.mocked(legacy.listProcesses).mockResolvedValue([
            { id, cwd: '', title: 'duplicate', incarnationId }
          ])
        }
      } finally {
        release.resolve()
      }
      await expect(stop).resolves.toEqual({ outcome: 'refused', reason: 'unverifiable' })
      expect(subprocess.forceKill).not.toHaveBeenCalled()
      expect(authorize).not.toHaveBeenCalled()
    }
  )
})

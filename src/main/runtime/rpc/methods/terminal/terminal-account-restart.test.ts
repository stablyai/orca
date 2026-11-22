import { expect, it, vi } from 'vitest'
import type { TerminalCreateRestartIntent } from '../../../terminal/identity/remote-runtime-terminal-create-idempotency'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { TERMINAL_METHODS } from './terminal'

const WORKTREE_ID = 'repo-1::/tmp/wt'
const PTY_ID = 'repo-1::/tmp/wt@@1a2b3c4d'
const restartIntent = {
  accountRestart: {
    requestId: 'request-1',
    attemptId: 'attempt-1',
    hostEpoch: 'host-epoch',
    pane: {
      worktreeId: WORKTREE_ID,
      tabId: 'original',
      leafId: '11111111-1111-4111-8111-111111111111',
      tabCreatedAt: 1
    },
    expected: {
      kind: 'endpoint',
      ptyId: PTY_ID,
      incarnationId: 'original-shell',
      bindingGeneration: 7
    }
  }
} satisfies TerminalCreateRestartIntent

it('never creates while reconciling an absent account-restart mutation', async () => {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/tmp/wt',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  const spawn = vi.fn()
  await expect(
    runtime.dedupeTerminalCreate(
      'device-a',
      `id:${WORKTREE_ID}`,
      'account-restart:request:attempt',
      true,
      spawn,
      { accountRestart: restartIntent }
    )
  ).rejects.toThrow('terminal_account_restart_outcome_unknown')
  expect(spawn).not.toHaveBeenCalled()
})

it.each(['paired', 'window'] as const)(
  'prevents a %s restart from reaching the stop after its RPC caller disconnects',
  async (surface) => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: WORKTREE_ID,
      path: '/tmp/wt',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const stopped = vi.fn()
    const create = async (signal?: AbortSignal) => {
      entered.resolve()
      await release.promise
      if (signal?.aborted) {
        throw new Error('client_disconnected')
      }
      stopped()
      return { handle: 'stopped-old-terminal', worktreeId: WORKTREE_ID, title: null }
    }
    if (surface === 'window') {
      vi.spyOn(runtime, 'startWindowTabTerminal').mockImplementation((_workspace, _pane, opts) =>
        create(opts.signal)
      )
    } else {
      vi.spyOn(runtime, 'createTerminal').mockImplementation((_workspace, opts) =>
        create(opts?.signal)
      )
    }
    const abort = new AbortController()
    const leafId = '11111111-1111-4111-8111-111111111111'
    const tabId = 'rpc-restart-tab'
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const pending = dispatcher.dispatch(
      {
        id: 'disconnect-restart',
        authToken: 'test',
        method: 'terminal.create',
        params: {
          worktree: `id:${WORKTREE_ID}`,
          tabId,
          leafId,
          ...(surface === 'window' ? { windowTab: true } : {}),
          accountRestart: {
            requestId: 'request-1',
            attemptId: 'attempt-1',
            hostEpoch: 'host-1',
            pane: { worktreeId: WORKTREE_ID, tabId, leafId, tabCreatedAt: 1 },
            expected: {
              kind: 'endpoint',
              ptyId: PTY_ID,
              incarnationId: 'inc-1',
              bindingGeneration: 1
            }
          }
        }
      },
      surface === 'window'
        ? { caller: { kind: 'desktop' }, signal: abort.signal }
        : { clientKind: 'runtime', pairedDeviceId: 'device-1', signal: abort.signal }
    )
    try {
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error(`Restart did not reach the host create entry: ${JSON.stringify(result)}`)
        })
      ])
      abort.abort()
    } finally {
      release.resolve()
    }
    expect(await pending).toMatchObject({ ok: false })
    expect(stopped).not.toHaveBeenCalled()
  }
)

it('refuses window-tab reconciliation before entering the restart spawn path', async () => {
  const runtime = new OrcaRuntimeService()
  const spawn = vi.spyOn(runtime, 'startWindowTabTerminal')
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const pane = {
    worktreeId: WORKTREE_ID,
    tabId: 'rpc-restart-tab',
    leafId: '11111111-1111-4111-8111-111111111111',
    tabCreatedAt: 1
  }
  const response = await dispatcher.dispatch(
    {
      id: 'reconcile-window-restart',
      authToken: 'test',
      method: 'terminal.create',
      params: {
        worktree: `id:${pane.worktreeId}`,
        tabId: pane.tabId,
        leafId: pane.leafId,
        windowTab: true,
        reconcileExisting: true,
        accountRestart: {
          requestId: 'request-1',
          attemptId: 'attempt-1',
          hostEpoch: 'host-1',
          pane,
          expected: {
            kind: 'endpoint',
            ptyId: PTY_ID,
            incarnationId: 'inc-1',
            bindingGeneration: 1
          }
        }
      }
    },
    { caller: { kind: 'desktop' } }
  )
  expect(response).toMatchObject({
    ok: false,
    error: { message: 'terminal_account_restart_outcome_unknown' }
  })
  expect(spawn).not.toHaveBeenCalled()
})

it('uses separate in-flight results and handles for creates and account restarts', async () => {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/tmp/wt',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  const ordinaryEntered = Promise.withResolvers<void>()
  const finishOrdinary = Promise.withResolvers<void>()
  const workspace = `id:${WORKTREE_ID}`
  const mutationId = '["request-1","attempt-1"]'
  const ordinary = runtime.dedupeTerminalCreate(
    'device-1',
    workspace,
    mutationId,
    false,
    async (_canonical, handle) => {
      ordinaryEntered.resolve()
      await finishOrdinary.promise
      return { handle: handle ?? '', worktreeId: WORKTREE_ID, title: 'ordinary' }
    }
  )
  await ordinaryEntered.promise
  const restart = runtime.dedupeTerminalCreate(
    'device-1',
    workspace,
    mutationId,
    false,
    async (_canonical, handle) => ({
      handle: handle ?? '',
      worktreeId: WORKTREE_ID,
      title: 'restart'
    }),
    { accountRestart: restartIntent }
  )
  finishOrdinary.resolve()
  const [created, restarted] = await Promise.all([ordinary, restart])
  expect(created.title).toBe('ordinary')
  expect(restarted.title).toBe('restart')
  expect(restarted.handle).not.toBe(created.handle)
})

it('shares only matching in-flight restart intent for the same request and attempt', async () => {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/tmp/wt',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const result = { handle: 'original-new-terminal', worktreeId: WORKTREE_ID, title: null }
  const otherSpawn = vi.fn(async () => result)
  const workspace = `id:${WORKTREE_ID}`
  const mutationId = '["request-1","attempt-1"]'
  const first = runtime.dedupeTerminalCreate(
    'device-1',
    workspace,
    mutationId,
    false,
    async () => {
      entered.resolve()
      await release.promise
      return result
    },
    { accountRestart: restartIntent }
  )
  await entered.promise
  const replay = runtime.dedupeTerminalCreate(
    'device-1',
    workspace,
    mutationId,
    false,
    otherSpawn,
    {
      accountRestart: structuredClone(restartIntent)
    }
  )
  const conflicting = runtime.dedupeTerminalCreate(
    'device-1',
    workspace,
    mutationId,
    false,
    otherSpawn,
    {
      accountRestart: {
        accountRestart: {
          ...restartIntent.accountRestart,
          pane: { ...restartIntent.accountRestart.pane, tabId: 'other-pane' }
        }
      }
    }
  )
  const rejected = expect(conflicting).rejects.toThrow('terminal_create_identity_conflict')
  release.resolve()
  await rejected
  expect(await first).toEqual(result)
  expect(await replay).toEqual(result)
  expect(otherSpawn).not.toHaveBeenCalled()
})

// A restarted runtime reissued the WSL worker's handle; the worker reports with its exported one.
// The receipt's adopt command must be the one the surviving terminal can run.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import * as startupShell from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import {
  closeTestStores,
  createStore,
  makeRepo,
  testState
} from '../../../../../persistence/persistence-test-harness'
import type { Store } from '../../../../../persistence/loading-store/store'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import { installFakeAppEnvironment } from '../../../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { replayAcceptedSend } from './send-replay'
import { SendParams } from './send-params'

const STALE_HANDLE = 'term_exported-before-restart'
const REMINTED_HANDLE = 'term_reissued-after-restart'
const WORKER_PANE = 'tab_worker:11111111-1111-4111-8111-111111111111'
const PTY_ID = 'wt::/repo/worker@@restored1'
const INCARNATION = `${PTY_ID}:inc-original`
const HOST_SCOPE = JSON.stringify({ kind: 'local', hostId: 'local' })

describe('the off-workspace receipt of a reminted WSL worker', () => {
  const harness = createOrchestrationRpcHarness()
  let store: Store
  let primary: string
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-pr-remint-'))
    store = createStore()
    // An apostrophe makes PowerShell and POSIX quoting of the selector differ.
    const pPath = join(testState.dir, "bob's p"),
      qPath = join(testState.dir, 'q')
    mkdirSync(pPath, { recursive: true })
    mkdirSync(qPath, { recursive: true })
    for (const [id, path] of [
      ['p', pPath],
      ['q', qPath]
    ]) {
      store.addRepo(
        makeRepo({
          id,
          path,
          gitRemoteIdentity: {
            canonicalKey: `github.com/org/${id}`,
            remoteName: 'origin',
            remoteUrl: `https://github.com/org/${id}`
          }
        })
      )
    }
    primary = `p::${pPath}`
    store.setWorktreeMeta(hostWorktreeTarget({ id: primary, hostId: 'local' }), {
      instanceId: 'primary-instance',
      createdAt: 1
    })
  })
  afterEach(async () => {
    installFakeAppEnvironment()
    harness.cleanup()
    vi.restoreAllMocks()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  /** The surviving PTY is a WSL terminal on a Windows host; only its reissued handle names it. */
  function setup(reminted: boolean) {
    const { db, runtime, ctx } = harness.setup(true, store)
    // A packaged app (installed after the store's own test environment): a dev build would tell
    // every terminal to run orca-dev.
    installFakeAppEnvironment({ isPackaged: () => true })
    const handle = reminted ? STALE_HANDLE : REMINTED_HANDLE
    const task = db.createTask({ spec: 'Make the change' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 1
    })
    db.recordWorkerStage({
      dispatchId: dispatch.id,
      stage: 'input',
      worktreeId: primary,
      terminalHandle: handle
    })
    db.db
      .prepare(
        'UPDATE dispatch_contexts SET assignee_handle = ?, assignee_pane_key = ?, process_incarnation = ?, host_scope = ? WHERE id = ?'
      )
      .run(handle, WORKER_PANE, INCARNATION, HOST_SCOPE, dispatch.id)
    db.markWorkerDispatchReady(dispatch.id)
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((h) =>
      h === 'term_coord' ? harness.coordinatorPaneKey : h === REMINTED_HANDLE ? WORKER_PANE : null
    )
    vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((h) =>
      h === REMINTED_HANDLE ? INCARNATION : null
    )
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockImplementation((paneKey) =>
      paneKey === WORKER_PANE ? REMINTED_HANDLE : null
    )
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      (incarnation, hostScope) =>
        incarnation === INCARNATION && hostScope === HOST_SCOPE ? REMINTED_HANDLE : null
    )
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    // The live terminal record: a local WSL PTY, found only through the reissued handle.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test reaches the runtime's own PTY lookup and record map to model one live WSL terminal; both members exist on OrcaRuntimeService.
    const internals = runtime as unknown as {
      resolveLeafForHandle: (h: string) => { ptyId: string | null } | null
      ptysById: Map<string, unknown>
    }
    vi.spyOn(internals, 'resolveLeafForHandle').mockImplementation((h) =>
      h === REMINTED_HANDLE ? { ptyId: PTY_ID } : null
    )
    internals.ptysById.set(PTY_ID, {
      ptyId: PTY_ID,
      incarnationId: null,
      worktreeId: primary,
      connectionId: null,
      runtimeSessionOwned: true,
      isWsl: true,
      wslDistro: 'Ubuntu'
    })
    // A Windows host: a terminal Orca cannot find gets the host's PowerShell quoting.
    vi.spyOn(startupShell, 'resolveStartupShell').mockReturnValue('powershell')
    const saved: unknown[] = []
    const callerCtx: RpcContext = {
      ...ctx,
      ...(reminted
        ? {
            orchestrationCompatibilityEvidence: {
              terminalHandle: STALE_HANDLE,
              paneKey: WORKER_PANE,
              launchToken: 'launch-token'
            }
          }
        : {}),
      recordMutationReceipt: (receipt: unknown) => saved.push(receipt)
    }
    const params = {
      from: handle,
      type: 'worker_done',
      subject: 'Opened org/q#17',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
    }
    return { db, runtime, callerCtx, params, saved, dispatchId: dispatch.id }
  }

  const warningOf = (receipt: unknown): string => {
    const warnings =
      receipt &&
      typeof receipt === 'object' &&
      'warnings' in receipt &&
      Array.isArray(receipt.warnings)
        ? receipt.warnings
        : []
    const found = warnings.flatMap((w: unknown) =>
      w &&
      typeof w === 'object' &&
      'code' in w &&
      w.code === 'pull_request_outside_workspace' &&
      'message' in w &&
      typeof w.message === 'string'
        ? [w.message]
        : []
    )
    expect(found).toHaveLength(1)
    return found[0]!
  }

  /** What a POSIX shell (the WSL terminal's) passes as the --parent-worktree argument. */
  const posixArgument = (message: string): string => {
    const tail = message.split(' --parent-worktree ')[1]!
    return execFileSync('/bin/sh', ['-c', `printf %s ${tail}`], { encoding: 'utf8' })
  }

  it.each([
    ['a reminted handle', true],
    ['its live handle (control)', false]
  ])(
    'reported through %s, tells the WSL terminal to run orca-ide with a POSIX selector',
    async (_name, reminted) => {
      const { db, runtime, callerCtx, params, saved, dispatchId } = setup(reminted)
      const receipt = await harness.call('orchestration.send', params, callerCtx)
      expect(receipt).toMatchObject({ lifecycle: { action: 'completed' } })
      expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
      const message = warningOf(receipt)
      expect(message).toContain(': orca-ide worktree adopt --path "<your-worktree-path>"')
      expect(message.endsWith(startupShell.quoteStartupArg(`id:${primary}`, 'posix'))).toBe(true)
      expect(posixArgument(message)).toBe(`id:${primary}`)
      // The classification stays bound to the settled Dispatch and its own workspace.
      expect(
        JSON.parse(db.getTask(db.getDispatchContextById(dispatchId)!.task_id)!.result!)
      ).toMatchObject({
        workspaceCheck: {
          version: 1,
          state: 'complete',
          outside: [{ forgeHost: 'github.com', owner: 'org', repo: 'q', number: 17 }]
        }
      })
      // The saved receipt replays as sent, with the same command.
      expect(saved).toHaveLength(1)
      const replayed = replayAcceptedSend(runtime, SendParams.parse(params), saved[0])
      expect(warningOf(replayed!.receipt)).toBe(message)
    }
  )
})

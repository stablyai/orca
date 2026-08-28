import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentHookServer, _internals } from './server'
import { createPretoolMutationResolver } from './pretool-gate-runtime-binding'

import { ClaudeHookService } from '../claude/hook-service'
import { getManagedScriptPath } from '../claude/hook-settings'
import { OrchestrationDb } from '../runtime/orchestration/db'
import {
  admitOutcome,
  outcomeFingerprint
} from '../runtime/orchestration/control-plane/outcome-identity'
import { ControlPlaneStore } from '../runtime/orchestration/control-plane/control-plane-store'
import { validationScopeKeyForWorktree } from '../runtime/orchestration/control-plane/validation-scope'
import { listPretoolReceipts } from '../runtime/orchestration/control-plane/pretool-receipt'
import { VALIDATION_LEASE_METHOD } from '../runtime/rpc/methods/validation-lease-method'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

const TOKEN = 'launch-token-abc'
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')
const HANDLE = 'term_builder'
const PANE = 'tab-1:leaf-1'
const INCARNATION = 'pty:term_builder'
const COORDINATOR_PANE = 'tab-coord:leaf-coord'

/** The whole fence, end to end, with nothing stubbed between the model's tool
 *  call and the lease row.
 *
 *  A real orchestration database holds a real Dispatch and a real lease. The
 *  production resolver is installed on the production hook server. The
 *  production managed script Orca installs into Claude is what runs, over the
 *  loopback endpoint, with the pane key and launch token the session was started
 *  with. The Bash command is executed only if that script allows it. */
describe('a real supervised worker is stopped before it mutates a leased worktree', () => {
  let db: OrchestrationDb
  let home: string
  let worktreePath: string
  let worktreeId: string
  let dispatchId: string
  let runId: string
  let taskId: string
  let target: string

  beforeEach(async () => {
    _internals.resetCachesForTests()
    home = mkdtempSync(join(tmpdir(), 'orca-bind-home-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), '{}')
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)

    worktreePath = mkdtempSync(join(tmpdir(), 'orca-bind-tree-'))
    worktreeId = `repo_a::${worktreePath}`
    target = join(worktreePath, 'role-route-registry.ts')
    writeFileSync(target, "if (route.identityProof !== 'exact') {\n")

    db = new OrchestrationDb(':memory:')
    runId = db.createRun({
      objective: 'Package B',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE
    }).id
    admitOutcome(new ControlPlaneStore(db), {
      outcomeId: 'out_1',
      runId,
      title: 'Package B',
      fingerprint: outcomeFingerprint(['package', 'b'])
    })
    const task = db.createTask({ spec: 'build package b', runId })
    taskId = task.id
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { agent: 'claude' }
    })
    dispatchId = started.dispatch.id
    db.prepareStartingWorkerAuthority({
      dispatchId,
      handle: HANDLE,
      paneKey: PANE,
      processIncarnation: INCARNATION,
      launchTokenHash: TOKEN_HASH,
      worktreeId,
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'external'
    })
    db.markWorkerDispatchReady(dispatchId, [])

    await agentHookServer.start({ env: 'production', userDataPath: home })
    agentHookServer.setPretoolMutationResolver(createPretoolMutationResolver(runtimeStub()))
    launchEnv = agentHookServer.buildPtyEnv()
    expect(new ClaudeHookService().install().state).toBe('installed')
  })

  afterEach(async () => {
    agentHookServer.setPretoolMutationResolver(null)
    await agentHookServer.stop?.()
    db?.close()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  /** Only the two lookups the resolver is allowed to make. Everything else it
   *  needs comes out of the real database. */
  function runtimeStub(
    placement: {
      terminalHandle: string | null
      processIncarnation: string | null
      worktreeId: string | null
    } | null = { terminalHandle: HANDLE, processIncarnation: INCARNATION, worktreeId }
  ): OrcaRuntimeService {
    return {
      getOrchestrationDb: () => db,
      resolveAttestedPanePlacement: (paneKey: string) => (paneKey === PANE ? placement : null)
    } as unknown as OrcaRuntimeService
  }

  /** Takes the lease through the REAL RPC — admitted outcome, exact Run, Task,
   *  Dispatch and worktree — so the scope, the ownership checks and the offline
   *  sentinel are all the production ones. It is owned by the very Dispatch
   *  whose model we then try to let edit. */
  async function leaseOwnedByTheBuilder(): Promise<{ leaseId: string; scopeKey: string }> {
    const result = (await VALIDATION_LEASE_METHOD.handler(
      { action: 'acquire', run: runId, dispatch: dispatchId, task: taskId, from: 'term_coord' },
      { runtime: leaseRuntime() }
    )) as { scopeKey: string; lease: { leaseId: string } }
    return { leaseId: result.lease.leaseId, scopeKey: result.scopeKey }
  }

  async function releaseTheLease(leaseId: string): Promise<{ released: boolean }> {
    return (await VALIDATION_LEASE_METHOD.handler(
      {
        action: 'release',
        run: runId,
        dispatch: dispatchId,
        task: taskId,
        leaseId,
        from: 'term_coord'
      },
      { runtime: leaseRuntime() }
    )) as { released: boolean }
  }

  /** The lease RPC only needs the database and the caller's Run binding. */
  function leaseRuntime(): OrcaRuntimeService {
    return {
      getOrchestrationDb: () => db,
      getTerminalPaneKey: () => COORDINATOR_PANE
    } as unknown as OrcaRuntimeService
  }

  /** A worker's environment is stamped at launch and does not change when Orca
   *  later dies, so it is captured up front rather than re-read per call. */
  let launchEnv: Record<string, string>

  async function runHook(
    toolName: string,
    toolInput: unknown,
    attestation: { paneKey?: string; launchToken?: string; worktreeId?: string } = {}
  ): Promise<{ status: number | null; stderr: string }> {
    const env = launchEnv
    // Async on purpose: the hook server is in THIS process, so a synchronous
    // spawn would block the loop that has to answer the script's own curl and
    // the timeout would read as "allowed" for the wrong reason.
    const child = spawn('/bin/sh', [getManagedScriptPath()], {
      env: {
        ...process.env,
        ...env,
        ORCA_PANE_KEY: attestation.paneKey ?? PANE,
        ORCA_TAB_ID: 'tab-1',
        ORCA_WORKTREE_ID: attestation.worktreeId ?? worktreeId,
        ORCA_AGENT_LAUNCH_TOKEN: attestation.launchToken ?? TOKEN
      }
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.stdout.resume()
    child.stdin.end(
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput })
    )
    const status = await new Promise<number | null>((resolve) => child.once('close', resolve))
    return { status, stderr }
  }

  /** Exactly what a provider does: run the tool only when the hook allowed it. */
  async function attemptBashMutation(
    attestation: Parameters<typeof runHook>[2] = {}
  ): Promise<number | null> {
    const command = `printf CONTAMINATED > ${target}`
    const hook = await runHook('Bash', { command }, attestation)
    if (hook.status !== 2) {
      await new Promise((resolve) => spawn('/bin/sh', ['-c', command]).once('close', resolve))
    }
    return hook.status
  }

  it('NEGATIVE CONTROL: the lease-owning builder is still blocked from its own Bash', async () => {
    const before = readFileSync(target)
    await leaseOwnedByTheBuilder()

    // Owning the lease is authority to RELEASE it, never authority to mutate
    // under it: the gate child process this builder started is reading the tree
    // right now, and its model editing that tree is the contamination.
    expect(await attemptBashMutation()).toBe(2)
    expect(readFileSync(target)).toEqual(before)
    expect(listPretoolReceipts(db, dispatchId)).toEqual([])
  })

  it('NEGATIVE CONTROL: an Edit from the same session is blocked byte-for-byte', async () => {
    const before = readFileSync(target)
    await leaseOwnedByTheBuilder()
    const hook = await runHook('Edit', { file_path: target, new_string: 'CONTAMINATED' })
    if (hook.status !== 2) {
      writeFileSync(target, 'CONTAMINATED')
    }
    expect(hook.status).toBe(2)
    expect(readFileSync(target)).toEqual(before)
  })

  it('NEGATIVE CONTROL: a Task call is fenced too — it can spawn a mutating subagent', async () => {
    await leaseOwnedByTheBuilder()
    expect((await runHook('Task', { prompt: 'edit the file' })).status).toBe(2)
  })

  it('NEGATIVE CONTROL: the wrong launch token cannot borrow this pane, lease or not', async () => {
    const before = readFileSync(target)
    // Deliberately NO lease: with one held every path denies, so the lease would
    // hide whether the token was ever checked. Supervised work has to be
    // attributable on its own.
    expect(await attemptBashMutation({ launchToken: 'a-token-from-somewhere-else' })).toBe(2)
    expect(readFileSync(target)).toEqual(before)
    expect(listPretoolReceipts(db, dispatchId)).toEqual([])
  })

  it('NEGATIVE CONTROL: and the same call with the right token is allowed', async () => {
    // The control for the above: only the token differs between the two.
    expect(await attemptBashMutation()).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('CONTAMINATED')
  })

  it('the wrong launch token is refused under a lease too', async () => {
    const before = readFileSync(target)
    await leaseOwnedByTheBuilder()
    expect(await attemptBashMutation({ launchToken: 'a-token-from-somewhere-else' })).toBe(2)
    expect(readFileSync(target)).toEqual(before)
  })

  it('NEGATIVE CONTROL: supervised work the runtime cannot place is refused', async () => {
    const before = readFileSync(target)
    await leaseOwnedByTheBuilder()
    // The pane IS carrying a Dispatch, so this is supervised work Orca is
    // answerable for — and it cannot say which workspace the mutation lands in.
    agentHookServer.setPretoolMutationResolver(createPretoolMutationResolver(runtimeStub(null)))
    expect(await attemptBashMutation()).toBe(2)
    expect(readFileSync(target)).toEqual(before)
  })

  it('NEGATIVE CONTROL: supervised work with no resolvable workspace is refused', async () => {
    const before = readFileSync(target)
    await leaseOwnedByTheBuilder()
    agentHookServer.setPretoolMutationResolver(
      createPretoolMutationResolver(
        runtimeStub({ terminalHandle: HANDLE, processIncarnation: INCARNATION, worktreeId: null })
      )
    )
    expect(await attemptBashMutation()).toBe(2)
    expect(readFileSync(target)).toEqual(before)
  })

  it('NEGATIVE CONTROL: a supervised call presenting NO launch token is refused', async () => {
    const before = readFileSync(target)
    await leaseOwnedByTheBuilder()
    // Absent is not exempt. A session that presents nothing has not shown it is
    // the session the work was dispatched to.
    expect(await attemptBashMutation({ launchToken: '' })).toBe(2)
    expect(readFileSync(target)).toEqual(before)
  })

  it('NEGATIVE CONTROL: supervised work with no recorded incarnation is refused', async () => {
    const before = readFileSync(target)
    await leaseOwnedByTheBuilder()
    agentHookServer.setPretoolMutationResolver(
      createPretoolMutationResolver(
        runtimeStub({ terminalHandle: HANDLE, processIncarnation: null, worktreeId })
      )
    )
    expect(await attemptBashMutation()).toBe(2)
    expect(readFileSync(target)).toEqual(before)
  })

  it('an ORDINARY pane with no Dispatch keeps working while the workspace is leased', async () => {
    // Nothing supervised is happening in it, so there is nothing for the fence
    // to protect and blocking it would strand real work.
    await leaseOwnedByTheBuilder()
    expect(await attemptBashMutation({ paneKey: 'tab-9:leaf-9' })).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('CONTAMINATED')
  })

  it('NEGATIVE CONTROL: a replaced provider session cannot reuse the old one’s answer', async () => {
    const before = readFileSync(target)
    await leaseOwnedByTheBuilder()
    agentHookServer.setPretoolMutationResolver(
      createPretoolMutationResolver(
        runtimeStub({
          terminalHandle: HANDLE,
          processIncarnation: 'pty:a-different-session',
          worktreeId
        })
      )
    )
    expect(await attemptBashMutation()).toBe(2)
    expect(readFileSync(target)).toEqual(before)
  })

  it('NEGATIVE CONTROL: losing the endpoint while leased still blocks', async () => {
    const before = readFileSync(target)
    await leaseOwnedByTheBuilder()
    // The sentinel is whatever the real acquire wrote — nothing is planted here.
    expect(agentHookServer.getEndpointFilePath()).toBeTruthy()
    await agentHookServer.stop?.()
    // Orca cannot answer. The durable sentinel is the only thing left, and on a
    // worktree with a gate running it has to mean deny.
    expect(await attemptBashMutation()).toBe(2)
    expect(readFileSync(target)).toEqual(before)
  })

  it('runs the very same Bash once the lease is gone', async () => {
    expect(await attemptBashMutation()).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('CONTAMINATED')
    expect(listPretoolReceipts(db, dispatchId)).toEqual([])
  })

  it('a rightful release lets the very same Bash run, even after an outage', async () => {
    const { leaseId } = await leaseOwnedByTheBuilder()
    expect(await attemptBashMutation()).toBe(2)

    // Release through the real RPC: it clears the durable marker as well as the
    // row, so the workspace is genuinely unfenced afterwards.
    expect(await releaseTheLease(leaseId)).toMatchObject({ released: true })
    await agentHookServer.stop?.()
    expect(await attemptBashMutation()).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('CONTAMINATED')
  })

  it('NEGATIVE CONTROL: a lease whose offline fence cannot be written is rolled back', async () => {
    const endpointFilePath = agentHookServer.getEndpointFilePath() as string
    const fenceDir = join(endpointFilePath, '..', 'fence')
    mkdirSync(fenceDir, { recursive: true })
    chmodSync(fenceDir, 0o500)
    try {
      // Reporting "acquired" here would hand the caller a half-armed fence: the
      // live gate would hold, and the moment Orca blinked the tree would be open.
      await expect(leaseOwnedByTheBuilder()).rejects.toMatchObject({
        code: 'fence_sentinel_unavailable'
      })
    } finally {
      chmodSync(fenceDir, 0o700)
    }
    // Rolled back, so the workspace is not left half-protected either.
    expect(await attemptBashMutation()).toBe(0)
  })

  it('NEGATIVE CONTROL: a retry that cannot re-arm the fence is rejected, lease intact', async () => {
    const { leaseId } = await leaseOwnedByTheBuilder()
    const fenceDir = join(agentHookServer.getEndpointFilePath() as string, '..', 'fence')
    chmodSync(fenceDir, 0o500)
    try {
      // Not certified: an acquired PASS with no durable offline fence is exactly
      // what must not be returned.
      await expect(leaseOwnedByTheBuilder()).rejects.toMatchObject({
        code: 'fence_refresh_failed'
      })
    } finally {
      chmodSync(fenceDir, 0o700)
    }
    // And the protection already in force is untouched.
    const held = new ControlPlaneStore(db).getValidationLease(
      validationScopeKeyForWorktree(worktreeId)
    )
    expect(held).toMatchObject({ lease_id: leaseId, released_at: null })
    // Still fencing, too.
    expect(await attemptBashMutation()).toBe(2)
  })

  it('NEGATIVE CONTROL: a runtime with no hook endpoint cannot take a lease at all', async () => {
    // Reporting "acquired" with no offline fence would hand the caller a
    // protection that evaporates the instant Orca is unreachable.
    await agentHookServer.stop?.()
    await expect(leaseOwnedByTheBuilder()).rejects.toMatchObject({
      code: 'fence_sentinel_unavailable'
    })
    expect(
      new ControlPlaneStore(db).getValidationLease(validationScopeKeyForWorktree(worktreeId))
    ).toBeUndefined()
  })

  it('lets an unleased session through when the endpoint is gone', async () => {
    await agentHookServer.stop?.()
    // No lease, no sentinel: an ordinary session keeps working when Orca is down.
    expect(await attemptBashMutation()).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('CONTAMINATED')
  })
})

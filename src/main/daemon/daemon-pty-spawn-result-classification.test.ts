import { expect, it, vi } from 'vitest'
import { DaemonPtySpawnResult } from './daemon-pty-spawn-result'
import { DaemonPtySessionSpawn } from './daemon-pty-session-spawn'
import type { DaemonPtySpawnContext } from './daemon-pty-spawn-request'
import { coldRestorePayloadFromInfo } from './cold-restore-payload-cache'
import type { CreateOrAttachResult } from './types'
import type { PtySpawnResult } from '../providers/pty-provider-contract'
import { OrcaRuntimeWithRegisterPty } from '../runtime/terminal/lifecycle/pty-registration'
import type { PtyRegistrationClaim } from '../runtime/runtime-terminal-state-records'
import { executePtySpawn } from '../ipc/pty/spawn-execute'
import { formatTerminalStartFailure } from '../../shared/terminal-start-failure'

abstract class SessionSpawnTestAdapter extends DaemonPtySessionSpawn {
  public override resultForExitBeforeSpawnReply(
    sessionId: string,
    result: CreateOrAttachResult,
    operation: DaemonPtySpawnContext['operation']
  ): PtySpawnResult | null {
    return super.resultForExitBeforeSpawnReply(sessionId, result, operation)
  }
}

it.each([
  { isNew: false, history: '' },
  { isNew: false, history: 'recovered history' },
  { isNew: true, history: '' }
])(
  'retains actual creation provenance through restore and registration ($isNew, $history)',
  async ({ isNew, history }) => {
    const id = 'restored-owner'
    const incarnationId = 'restored-incarnation'
    const restoreInfo = {
      snapshotAnsi: '',
      scrollbackAnsi: history,
      rehydrateSequences: '\x1b[?1049h',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      modes: {
        alternateScreen: true,
        bracketedPaste: false,
        mouseTracking: false,
        applicationCursor: false
      }
    }
    const context: DaemonPtySpawnContext = {
      opts: { sessionId: id, cols: 80, rows: 24, cwd: '/tmp' },
      operation: {
        exitsBySessionId: new Map(),
        ignoredExitIncarnationIds: new Set(),
        ignoreNextExit: false
      },
      historyRecovery: { freeze: null, unreadableSessionId: null, identityChanged: false },
      requestedSessionId: id,
      attachOnly: false,
      emulateLegacyAttachOnly: false,
      restoreSkippedForLiveSession: false,
      sessionId: id,
      wslDistro: undefined,
      restoreInfo,
      effectiveCwd: '/tmp',
      effectiveCols: 80,
      effectiveRows: 24,
      shellReadySupported: false,
      shellReadyTimeoutMs: undefined,
      historySeedSegments: null,
      detectColdRestore: async () => restoreInfo
    }
    const cache = new Map()
    const owner: {
      finishSpawn(
        context: DaemonPtySpawnContext,
        result: CreateOrAttachResult
      ): Promise<PtySpawnResult>
    } = Object.assign(Object.create(DaemonPtySpawnResult.prototype), {
      clearSessionAwaitingDaemonRecovery: vi.fn(),
      ptyInventory: { spawned: vi.fn() },
      sessionIncarnations: new Map(),
      inputClosedIncarnations: { sync: vi.fn() },
      hostLossSessionIds: new Set(),
      noteSpawnWslDistro: vi.fn(),
      initialCwds: new Map(),
      coldRestoreCache: cache,
      activeSessionIds: new Set(),
      buildColdRestorePayload: coldRestorePayloadFromInfo,
      resultForExitBeforeSpawnReply: SessionSpawnTestAdapter.prototype.resultForExitBeforeSpawnReply
    })
    const lower: CreateOrAttachResult = {
      isNew,
      snapshot: { ...restoreInfo, scrollbackLines: 0, outputSequence: 10 },
      incarnationId,
      historySeeded: false,
      pid: 12345,
      shellState: 'ready',
      wslDistro: null
    }
    const result = await owner.finishSpawn(context, lower)
    expect(result).toMatchObject({
      id,
      incarnationId,
      pid: lower.pid,
      wslDistro: null,
      providerSequence: { value: isNew ? 0 : 10, generation: isNew ? 'reset' : 'continued' }
    })
    expect(result.coldRestore).toEqual(coldRestorePayloadFromInfo(restoreInfo) ?? undefined)
    expect(cache.get(id)).toEqual(result.coldRestore)
    if (result.coldRestore) {
      expect(await owner.finishSpawn(context, lower)).toMatchObject({
        id,
        incarnationId,
        isReattach: true,
        coldRestore: result.coldRestore
      })
    }
    const cause = {
      kind: 'exited',
      exitCode: 256,
      initialOutputDiagnostic: 'git-bash-console-capacity'
    } as const
    const pending = new Map<string, PtyRegistrationClaim>()
    const runtime: Pick<
      OrcaRuntimeWithRegisterPty,
      | 'beginPtyRegistration'
      | 'cancelPendingPtyRegistration'
      | 'assertPtyRegistrationAllowed'
      | 'narrowPtyRegistration'
    > = Object.assign(Object.create(OrcaRuntimeWithRegisterPty.prototype), {
      pendingPtyRegistrationIncarnations: pending,
      ptyLivenessVerdictByPtyId: new Map([
        [id, { verdict: { status: 'exited', incarnationId, cause } }]
      ])
    })
    const begin = vi.spyOn(runtime, 'beginPtyRegistration')
    const cancel = vi.spyOn(runtime, 'cancelPendingPtyRegistration')
    const spawn = vi.fn(async () => {
      const claim = pending.get(id)
      expect(claim).toBeDefined()
      claim?.exitedIncarnations.add(incarnationId)
      return result
    })
    const ctx = {
      args: { cols: 80, rows: 24 },
      deps: { trustedTerminalHandleEnv: new Set(), runtime },
      provider: { spawn },
      spawnOptions: { sessionId: id },
      result: { id: '' },
      preAdoptedStablePane: null,
      stablePaneOwner: null,
      pendingRegistrationPtyId: null,
      rejectedRegistrationCandidate: null,
      preparedProvisionalExecutionContext: false,
      isDaemonHostSpawn: false,
      expectedWslDistro: null,
      isClaudeLaunch: false,
      ownsNewIncarnation: false,
      provisionalPtySize: undefined,
      resumeAdmission: null
    }
    const error = await executePtySpawn(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these dispatch/runtime ports are reached before the matched registration refusal.
      ctx as never,
      { sessionId: id, paneKey: null },
      async () => {}
    ).catch((error: unknown) => error)
    expect(error).toMatchObject({
      message: 'agent_session_exited_during_start',
      terminalExitIncarnationId: incarnationId
    })
    expect(formatTerminalStartFailure(error) !== undefined).toBe(isNew)
    expect(result.isReattach).toBe(isNew ? undefined : true)
    expect(spawn).toHaveBeenCalledOnce()
    expect(cancel.mock.calls).toEqual([[id, incarnationId, begin.mock.results[0]?.value]])
    expect(pending.size).toBe(0)
  }
)

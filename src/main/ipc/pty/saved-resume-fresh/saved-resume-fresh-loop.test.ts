import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../../agent-hooks/server'
import { buildBody, PANE, postHookEvent } from '../../../agent-hooks/server.test-fixtures'
import type { ResumeSpawnAdmission } from '../host-env/saved-resume-admission'
import type { PtySpawnOperationState } from '../spawn-operation-state'
import { localProvider } from '../provider/registry'
import { spawnPtyFromRuntimeController } from '../runtime/spawn'
import type { createRuntimePtySpawnState } from '../runtime/spawn-state'
import { savedResumeDeps, savedResumeHost } from '../runtime/spawn-saved-resume.test-fixture'
import { CODEX_HEADER, codexSessionsDay, writeStoreFile } from './agent-store.test-fixture'
import { SAVED_RESTORE_CHECK_ENV } from '../../../../shared/saved-restore-dispatch'
import { armSavedRestoreCheck } from './saved-restore-arm'
import {
  completeSavedRestoreFresh,
  decideSavedRestore,
  settleSavedRestoreLaunch
} from './saved-restore-receipt'

const live = vi.hoisted(() => ({ server: null as unknown as AgentHookServer, home: '' }))

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../../agent-hooks/server', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal()
  // Main's decision reads whichever server this restart hydrated.
  const agentHookServer = new Proxy(
    {},
    {
      get: (_target, key) => {
        const value = Reflect.get(live.server, key)
        return typeof value === 'function' ? value.bind(live.server) : value
      }
    }
  )
  return { ...actual, agentHookServer }
})

vi.mock('../../../cli/orca-cli-child-path', () => ({
  prependOrcaCliDirToChildPath: () => '/app/bin/orca'
}))
vi.mock('../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ isPackaged: () => true, getPath: () => '/user-data' }),
  hasAppEnvironment: () => true
}))
// The launch's private action, as the arm hands it to the PTY host's root shell.
const actions = vi.hoisted(
  () => new Map<string, { entry: string; token: string; freshArgs: readonly string[] }>()
)
vi.mock('./saved-restore-script-files', () => ({
  ensureSavedRestoreScripts: () => '/scripts/restore',
  writeSavedRestoreAction: (data: { entry: string; token: string; freshArgs: string[] }) => {
    const path = `/actions/${actions.size}/action`
    actions.set(path, data)
    return path
  },
  discardSavedRestoreAction: () => {}
}))
vi.mock('../runtime/spawn-preflight', () => ({ prepareRuntimePtySpawn: vi.fn(async () => null) }))
// Host env routing settled on this Codex home; everything after it is the real spawn and commit.
vi.mock('../runtime/spawn-options', () => ({
  buildRuntimePtySpawnOptions: vi.fn(async (ctx: ReturnType<typeof createRuntimePtySpawnState>) => {
    const codexHome = join(live.home, 'codex')
    ctx.spawnIdentityPaneKey = PANE
    ctx.launchCommand = ctx.args.command
    ctx.selectedCodexHomePath = codexHome
    ctx.codexHomeLaunchStartedAt = new Date()
    ctx.spawnOptions = {
      cols: ctx.args.cols,
      rows: ctx.args.rows,
      command: ctx.args.command,
      env: {
        ...ctx.args.env,
        HOME: live.home,
        SHELL: '/bin/zsh',
        CODEX_HOME: codexHome,
        ORCA_CODEX_HOME: codexHome
      },
      launchAgent: ctx.args.launchAgent
    }
    ctx.env = ctx.spawnOptions.env
    return null
  })
}))

const OLD = '019f1abc-0000-7000-8000-00000000aaaa'
const NEW = '019f1abc-0000-7000-8000-00000000bbbb'
let userData: string
let home: string
const servers: AgentHookServer[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  userData = mkdtempSync(join(tmpdir(), 'orca-fresh-loop-data-'))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'orca-fresh-loop-home-')))
  live.home = home
  mkdirSync(join(home, 'codex', 'sessions'), { recursive: true })
})

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  rmSync(userData, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

/** One app start: a new hook server that hydrates what the previous one persisted. */
async function restart(): Promise<AgentHookServer> {
  servers.splice(0).forEach((server) => server.stop())
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath: userData })
  live.server = server
  return server
}

/** The pane's saved Codex restore as both spawn lanes hand it to main. */
function savedRestore(id: string) {
  const codexHome = join(home, 'codex')
  const command = `codex 'resume' '${id}'`
  const providerSession = { key: 'session_id' as const, id }
  const ctx = {
    args: {
      command,
      worktreeId: 'wt-1',
      launchAgent: 'codex',
      resumeProviderSession: providerSession,
      resumeOrigin: 'saved',
      launchConfig: {
        agentCommand: 'codex --sandbox workspace-write',
        agentArgs: '',
        agentEnv: {}
      },
      env: {}
    },
    spawnOptions: {
      cols: 80,
      rows: 24,
      command,
      env: {
        HOME: home,
        SHELL: '/bin/zsh',
        CODEX_HOME: codexHome,
        ORCA_CODEX_HOME: codexHome,
        ORCA_PANE_KEY: PANE
      },
      envToDelete: []
    },
    cwd: home,
    expectedWslDistro: null,
    isDaemonHostSpawn: true,
    provider: { supportsSavedRestorePrivateStartup: () => true },
    launchCommand: command,
    deps: { getSettings: () => ({ codexManagedAccounts: [], agentCmdOverrides: {} }) }
  }
  const row = live.server.getStatusSnapshotForPane(PANE)[0]
  const admission: ResumeSpawnAdmission = {
    verdict: 'admitted',
    refused: {
      agent: 'codex',
      providerSession,
      ...(row
        ? {
            expectedStatus: {
              paneKey: PANE,
              receivedAt: row.receivedAt,
              stateStartedAt: row.stateStartedAt
            }
          }
        : {})
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the decision reads only these members of the spawn state.
  const state = ctx as unknown as PtySpawnOperationState
  const runtime = {
    releaseAgentSessionResumeHold: vi.fn(),
    forgetRefusedSavedResume: vi.fn(async () => {}),
    publishTerminalSavedRestoreFresh: vi.fn()
  }
  /** What the check reports from its own env: the installed entry and this pane, no launch token. */
  const caller = () => ({
    entry: actions.get(state.spawnOptions.env?.ORCA_SAVED_RESTORE_ACTION ?? '')?.entry ?? '',
    paneKey: PANE,
    launchToken: null
  })
  return {
    state,
    runtime,
    /** Main before spawn: arms the generated line's in-pane check when the pane shows only a seed. */
    arm: async () => {
      await armSavedRestoreCheck(state, PANE, { shellOverride: undefined }, admission)
      return state.savedRestoreProof
    },
    /** What commit does once the PTY is up: the resumed launch seeds, and the check may now run. */
    commit: () => {
      live.server.recordLaunchResumeIdentity({
        paneKey: PANE,
        agentType: 'codex',
        providerSession,
        launchedAt: Date.now() + 1
      })
      settleSavedRestoreLaunch(state.savedRestoreProof, {
        ptyId: 'restored-pty',
        incarnationId: undefined,
        owner: undefined,
        launchToken: undefined
      })
    },
    /** Codex's function at its call-through, in the pane's own env. */
    check: (args = ['resume', id]) =>
      decideSavedRestore({
        ...caller(),
        token: state.savedRestoreProof ?? '',
        agent: 'codex',
        args,
        roots: { HOME: home, CODEX_HOME: codexHome },
        cwd: home,
        remainingMs: 4_000
      }),
    dispatched: () =>
      completeSavedRestoreFresh(
        state.savedRestoreProof ?? '',
        caller(),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: completion reads only these members.
        runtime as never
      )
  }
}

async function hook(event: string, id: string): Promise<void> {
  const response = await postHookEvent(
    live.server,
    buildBody({ hook_event_name: event, session_id: id }),
    '/hook/codex'
  )
  expect(response.status).toBe(204)
}

describe('a saved pane whose conversation its agent no longer has', () => {
  it('resumes once, starts fresh on the next restart, then follows the new conversation', async () => {
    await restart()
    await hook('SessionStart', OLD)
    await hook('Stop', OLD)

    // Restart 1: the latest row is the agent's own hook, so the saved resume runs with no check.
    let launch = savedRestore(OLD)
    await expect(launch.arm()).resolves.toBeUndefined()
    expect(launch.state.spawnOptions.command).toBe(`codex 'resume' '${OLD}'`)
    launch.commit()

    // Restart 2: the command is unchanged but carries the check; the pane's store lacks it.
    await restart()
    launch = savedRestore(OLD)
    await expect(launch.arm()).resolves.toMatch(/^[0-9a-f]{32}$/)
    expect(launch.state.spawnOptions.command).toBe(`codex 'resume' '${OLD}'`)
    expect(launch.state.spawnOptions.env).toMatchObject({
      [SAVED_RESTORE_CHECK_ENV]: '/app/bin/orca',
      ORCA_SAVED_RESTORE_ORIGINAL: `codex 'resume' '${OLD}'`
    })
    const action = actions.get(launch.state.spawnOptions.env?.ORCA_SAVED_RESTORE_ACTION ?? '')
    expect(action?.freshArgs.slice(0, 2)).toEqual(['--sandbox', 'workspace-write'])
    launch.commit()
    await expect(launch.check()).resolves.toBe('fresh')
    // Nothing is forgotten or shown until the generated line reports it ran the fresh arguments.
    expect(live.server.getStatusSnapshotForPane(PANE)).not.toEqual([])
    launch.dispatched()
    launch.dispatched()
    expect(live.server.getStatusSnapshotForPane(PANE)).toEqual([])
    expect(launch.runtime.publishTerminalSavedRestoreFresh).toHaveBeenCalledOnce()
    expect(launch.runtime.publishTerminalSavedRestoreFresh).toHaveBeenCalledWith(
      expect.objectContaining({ paneKey: PANE, ptyId: 'restored-pty' })
    )
    expect(launch.runtime.forgetRefusedSavedResume).toHaveBeenCalledOnce()
    expect(launch.runtime.releaseAgentSessionResumeHold).toHaveBeenCalledOnce()
    // A replay of the generated line finds its proof spent and resumes.
    await expect(launch.check()).resolves.toBe('resume')
    await hook('SessionStart', NEW)

    // Restart 3: the new conversation resumes, with no check of the old one.
    await restart()
    expect(
      live.server.getStatusSnapshotForPane(PANE).map((row) => row.providerSession?.id)
    ).toEqual([NEW])
    launch = savedRestore(NEW)
    await expect(launch.arm()).resolves.toBeUndefined()
    expect(launch.state.spawnOptions.command).toBe(`codex 'resume' '${NEW}'`)
  })

  it('gives a destination that cannot own the start the plain resume and no startup inputs', async () => {
    await restart()
    savedRestore(OLD).commit()
    await restart()
    const launch = savedRestore(OLD)
    launch.state.provider.supportsSavedRestorePrivateStartup = () => false
    await expect(launch.arm()).resolves.toBeUndefined()
    expect(launch.state.spawnOptions.command).toBe(`codex 'resume' '${OLD}'`)
    expect(launch.state.spawnOptions.env).not.toHaveProperty('ORCA_SAVED_RESTORE_ACTION')
  })

  it('keeps resuming when the agent reported anything after the launch', async () => {
    await restart()
    savedRestore(OLD).commit()
    await hook('UserPromptSubmit', OLD)
    await restart()
    await expect(savedRestore(OLD).arm()).resolves.toBeUndefined()
  })

  it('keeps resuming when a terminal observation followed a hook and the pane was torn down', async () => {
    await restart()
    savedRestore(OLD).commit()
    await hook('SessionStart', OLD)
    live.server.ingestTerminalStatus({
      paneKey: PANE,
      origin: 'process',
      payload: { state: 'working', prompt: '', agentType: 'codex' }
    })
    live.server.dropStatusEntry(PANE)
    await restart()
    expect(live.server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(OLD)
    await expect(savedRestore(OLD).arm()).resolves.toBeUndefined()
  })

  it('resumes while the store still has it, for a changed command, or a lost answer', async () => {
    await restart()
    savedRestore(OLD).commit()
    writeStoreFile(
      join(codexSessionsDay(join(home, 'codex')), `rollout-2026-06-30T10-00-00-${OLD}.jsonl`),
      CODEX_HEADER
    )
    await restart()
    let launch = savedRestore(OLD)
    await launch.arm()
    launch.commit()
    await expect(launch.check()).resolves.toBe('resume')

    rmSync(join(home, 'codex', 'sessions'), { recursive: true })
    mkdirSync(join(home, 'codex', 'sessions'))
    launch = savedRestore(OLD)
    await launch.arm()
    launch.commit()
    await expect(launch.check(['resume', OLD, '--search'])).resolves.toBe('resume')

    // A fresh answer the shell never received: no report, so nothing is forgotten or shown.
    launch = savedRestore(OLD)
    await launch.arm()
    launch.commit()
    await expect(launch.check()).resolves.toBe('fresh')
    expect(live.server.getStatusSnapshotForPane(PANE)).not.toEqual([])
    expect(launch.runtime.publishTerminalSavedRestoreFresh).not.toHaveBeenCalled()
  })

  it('withdraws a fresh answer when a hook lands while the store is read', async () => {
    await restart()
    savedRestore(OLD).commit()
    await restart()
    const launch = savedRestore(OLD)
    await launch.arm()
    launch.commit()
    const choice = launch.check()
    await hook('UserPromptSubmit', OLD)
    await expect(choice).resolves.toBe('resume')
  })

  it('re-seeds over the retained remnant teardown leaves, so the next restart checks in the pane', async () => {
    await restart()
    await hook('SessionStart', OLD)
    await hook('Stop', OLD)
    // Teardown keeps the hook row's identity as a session-only remnant that still names its hook.
    live.server.dropStatusEntry(PANE)
    expect(live.server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      providerSessionOnly: true
    })

    const spawn = vi.spyOn(localProvider, 'spawn').mockResolvedValue({ id: 'restored-pty' })
    const restore = () =>
      spawnPtyFromRuntimeController(
        savedResumeDeps(savedResumeHost(() => live.server.getStatusSnapshot())),
        {
          cols: 80,
          rows: 24,
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          command: `codex 'resume' '${OLD}'`,
          launchAgent: 'codex',
          resumeOrigin: 'saved',
          resumeProviderSession: { key: 'session_id', id: OLD },
          launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
          env: { ORCA_PANE_KEY: PANE }
        }
      )
    try {
      // Restart 1, through the real spawn and commit: the remnant names a hook, so no check.
      await restore()
      expect(spawn.mock.calls[0]?.[0].command).toBe(`codex 'resume' '${OLD}'`)
      await restart()
      // Restart 2: that resumed launch's own seed is last; the pane's function asks main.
      await restore()
      const armed = spawn.mock.calls[1]?.[0]
      expect(armed?.command).toBe(`codex 'resume' '${OLD}'`)
      const { entry = '', token = '' } =
        actions.get(armed?.env?.ORCA_SAVED_RESTORE_ACTION ?? '') ?? {}
      await expect(
        decideSavedRestore({
          entry,
          paneKey: PANE,
          launchToken: null,
          token,
          agent: 'codex',
          args: ['resume', OLD],
          roots: { HOME: home, CODEX_HOME: join(home, 'codex') },
          cwd: home,
          remainingMs: 4_000
        })
      ).resolves.toBe('fresh')
    } finally {
      spawn.mockRestore()
    }
  })
})

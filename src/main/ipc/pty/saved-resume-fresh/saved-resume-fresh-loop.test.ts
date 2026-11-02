import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../../agent-hooks/server'
import { buildBody, PANE, postHookEvent } from '../../../agent-hooks/server.test-fixtures'
import type { ResumeSpawnAdmission } from '../host-env/saved-resume-admission'
import type { PtySpawnOperationState } from '../spawn-operation-state'
import { CODEX_HEADER, codexSessionsDay, writeStoreFile } from './agent-store.test-fixture'
import {
  forgetStartedFreshResume,
  startSavedResumeFreshWhenMissing
} from './saved-resume-fresh-launch'

const live = vi.hoisted(() => ({ server: null as unknown as AgentHookServer }))

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

const OLD = '019f1abc-0000-7000-8000-00000000aaaa'
const NEW = '019f1abc-0000-7000-8000-00000000bbbb'
let userData: string
let home: string
const servers: AgentHookServer[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  userData = mkdtempSync(join(tmpdir(), 'orca-fresh-loop-data-'))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'orca-fresh-loop-home-')))
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
      env: { HOME: home, SHELL: '/bin/zsh', CODEX_HOME: codexHome, ORCA_CODEX_HOME: codexHome },
      envToDelete: []
    },
    cwd: home,
    expectedWslDistro: null,
    isDaemonHostSpawn: true,
    selectedCodexHomePath: codexHome,
    codexResumeHomeSelected: false,
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
  return {
    state,
    choose: () =>
      startSavedResumeFreshWhenMissing(state, PANE, { shellOverride: undefined }, admission),
    /** What commit does once the PTY is up: resumes seed this launch; a fresh start consumes the old seed. */
    commit: (startedFresh: boolean) => {
      if (startedFresh) {
        forgetStartedFreshResume(PANE, admission)
      } else {
        live.server.recordLaunchResumeIdentity({
          paneKey: PANE,
          agentType: 'codex',
          providerSession,
          launchedAt: Date.now() + 1
        })
      }
    }
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

    // Restart 1: the latest row is the agent's own hook, so the saved resume runs and re-seeds.
    let launch = savedRestore(OLD)
    await expect(launch.choose()).resolves.toBe(false)
    expect(launch.state.spawnOptions.command).toBe(`codex 'resume' '${OLD}'`)
    launch.commit(false)

    // Restart 2: nothing reported since that launch and Codex's store lacks it: fresh, same recipe.
    await restart()
    launch = savedRestore(OLD)
    await expect(launch.choose()).resolves.toBe(true)
    expect(launch.state.spawnOptions.command).toMatch(/^codex --sandbox workspace-write\b/)
    expect(launch.state.spawnOptions.command).not.toContain(OLD)
    expect(launch.state.args.resumeProviderSession).toBeUndefined()
    launch.commit(true)
    expect(live.server.getStatusSnapshotForPane(PANE)).toEqual([])
    await hook('SessionStart', NEW)

    // Restart 3: the new conversation resumes; the old one is gone from main's rows.
    await restart()
    expect(
      live.server.getStatusSnapshotForPane(PANE).map((row) => row.providerSession?.id)
    ).toEqual([NEW])
    launch = savedRestore(NEW)
    await expect(launch.choose()).resolves.toBe(false)
    expect(launch.state.spawnOptions.command).toBe(`codex 'resume' '${NEW}'`)
  })

  it('keeps resuming when the agent reported anything after the launch', async () => {
    await restart()
    savedRestore(OLD).commit(false)
    await hook('UserPromptSubmit', OLD)
    await restart()
    await expect(savedRestore(OLD).choose()).resolves.toBe(false)
  })

  it('keeps resuming when a terminal observation followed a hook and the pane was torn down', async () => {
    await restart()
    savedRestore(OLD).commit(false)
    await hook('SessionStart', OLD)
    live.server.ingestTerminalStatus({
      paneKey: PANE,
      origin: 'process',
      payload: { state: 'working', prompt: '', agentType: 'codex' }
    })
    live.server.dropStatusEntry(PANE)
    await restart()
    expect(live.server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(OLD)
    await expect(savedRestore(OLD).choose()).resolves.toBe(false)
  })

  it('keeps resuming while the store still has it, or when main kept no row at all', async () => {
    await restart()
    await expect(savedRestore(OLD).choose()).resolves.toBe(false)
    const launch = savedRestore(OLD)
    launch.commit(false)
    launch.commit(false)
    writeStoreFile(
      join(codexSessionsDay(join(home, 'codex')), `rollout-2026-06-30T10-00-00-${OLD}.jsonl`),
      CODEX_HEADER
    )
    await restart()
    await expect(savedRestore(OLD).choose()).resolves.toBe(false)
  })

  it('withdraws a fresh start when a hook lands while the store is read', async () => {
    await restart()
    savedRestore(OLD).commit(false)
    await restart()
    const launch = savedRestore(OLD)
    const choice = launch.choose()
    live.server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'codex',
      providerSession: { key: 'session_id', id: OLD },
      launchedAt: Date.now() + 1
    })
    await expect(choice).resolves.toBe(false)
    expect(launch.state.spawnOptions.command).toBe(`codex 'resume' '${OLD}'`)
  })
})

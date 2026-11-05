import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import '../../../claude/claude-cli-conversations'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { localProvider } from '../provider/registry'
import { spawnPtyFromRuntimeController } from './spawn'
import * as owners from '../pane/agent-session-owners'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { finishPtyShutdown } from '../provider/liveness'
import { listStructuredProviderSessionOwnership } from '../../../native-chat/agent-session-wire/host/structured-provider-session-ownership'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { executePtySpawn } from '../spawn-execute'
import { prepareSavedPtyResume } from '../spawn-resume'
import {
  admitColdRestoreReattach,
  admitResumeSpawn,
  savedResumeResult
} from '../host-env/saved-resume-admission'
import { createRuntimePtySpawnState } from './spawn-state'

async function executePreparedSpawn(ctx: ReturnType<typeof createRuntimePtySpawnState>) {
  const facts = {
    sessionId: ctx.sessionId,
    paneKey: ctx.spawnIdentityPaneKey,
    savedResumePaneKey: ctx.spawnIdentityPaneKey,
    launchConfig: ctx.args.launchConfig,
    suppressRefusedLaunch: () => {
      ctx.launchCommand = undefined
      ctx.env = ctx.spawnOptions.env
    }
  }
  await executePtySpawn(ctx, facts, await prepareSavedPtyResume(ctx, facts))
}

const forgetRefusedPaneResume = vi.hoisted(() => vi.fn())
vi.mock('../../../agent-hooks/server', () => ({ agentHookServer: { forgetRefusedPaneResume } }))

vi.mock('./spawn-preflight', () => ({ prepareRuntimePtySpawn: vi.fn(async () => null) }))
vi.mock('./spawn-options', () => ({
  buildRuntimePtySpawnOptions: vi.fn(async (ctx: ReturnType<typeof createRuntimePtySpawnState>) => {
    ctx.spawnIdentityPaneKey = 'tab-1:leaf'
    ctx.spawnOptions = {
      cols: ctx.args.cols,
      rows: ctx.args.rows,
      command: ctx.args.command,
      env: ctx.args.env,
      launchAgent: ctx.args.launchAgent
    }
    return null
  })
}))

const C = 'provider-session-alpha-1'
const chat = agentSessionRecordFixture(
  agentSessionLeaseFixture({
    claimStatus: 'released',
    ownerProcess: null,
    reservedSpawnToken: null,
    deathEvidence: { kind: 'exit-observed', detail: 'closed', observedAt: 1 }
  })
)

const store = {
  listConversations: () => [agentSessionConversationView(chat)],
  getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [chat.sessionId] })
}

/** A host whose one chat continues C at rest, with its tab open. */
function chatHost() {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the admission reads only the two members `store` has.
    openAgentSessionRecordStore: async () => store as unknown as AgentSessionRecordStore,
    getTerminalLaunchResult: vi.fn(),
    forgetRefusedSavedResume: vi.fn(async () => {}),
    getAgentProviderSessionRows: () => [
      {
        paneKey: 'tab-1:leaf',
        connectionId: null,
        agentType: 'claude' as const,
        state: 'working' as const,
        prompt: '',
        receivedAt: 1,
        stateStartedAt: 1,
        providerSession: { key: 'session_id' as const, id: C }
      }
    ]
  }
}

function deps(runtime: ReturnType<typeof chatHost>): PtyRuntimeControllerDeps {
  const noCodexResumeLaunch: PtyRuntimeControllerDeps['noCodexResumeLaunch'] = (command) => ({
    codexResumeHome: null,
    command,
    notifyResumeUnavailable: false,
    droppedResumeArgv: false,
    providerSession: null
  })
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preflight reads only the admission members `chatHost` provides.
    runtime: runtime as unknown as OrcaRuntimeService,
    store: undefined,
    getSettings: () => getDefaultSettings('/tmp'),
    adoptStablePane: async (args) => {
      await args.spawnFresh?.({ mustExist: false })
      return null
    },
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    prepareCodexResumeHome: () => null,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome: async (resumeHome) => resumeHome.codexHomePath,
    stripSequencedStartupResumeArgv: (env) => env,
    assertWorkspaceAcceptsNewPty: () => undefined,
    resolvePtySpawnStartupCwd: (_worktreeId, cwd) => cwd,
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async () => false,
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: () => {},
    sendPtySpawnedToRenderer: () => {},
    finishPtyShutdown,
    trustedTerminalHandleEnv: new Set(),
    retiredRejectedPtyIds: new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the spawn preflight never touches `mainWindow`.
    mainWindow: {} as BrowserWindow
  }
}

describe('actual runtime saved-resume outcomes', () => {
  function freshContext(runtime = chatHost()) {
    const ctx = createRuntimePtySpawnState(deps(runtime), {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      command: `claude --resume ${C}`,
      launchAgent: 'claude',
      resumeProviderSession: { key: 'session_id', id: C },
      resumeOrigin: 'saved',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: { AGENT_ONLY: 'yes' } },
      env: {
        WORKSPACE: 'keep',
        AGENT_ONLY: 'yes',
        ORCA_AGENT_LAUNCH_TOKEN: 'rejected',
        ORCA_SEQUENCED_STARTUP_COMMAND: `claude --resume ${C}`,
        ORCA_SEQUENCED_STARTUP_SCRIPT: `fallback claude --resume ${C}`
      }
    })
    ctx.spawnOptions = {
      cols: 80,
      rows: 24,
      command: ctx.args.command,
      launchAgent: 'claude',
      env: { ...ctx.args.env }
    }
    return ctx
  }

  it('chooses a plain shell only in the fresh callback and does not forget before commit', async () => {
    const runtime = chatHost()
    const ctx = freshContext(runtime)
    const spawn = vi.spyOn(ctx.provider, 'spawn').mockResolvedValue({ id: 'plain-shell' })
    try {
      expect(ctx.args.command).toContain(C)
      await executePreparedSpawn(ctx)
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          env: { WORKSPACE: 'keep' }
        })
      )
      expect(ctx.spawnOptions.command).toBeUndefined()
      expect(ctx.args.launchAgent).toBeUndefined()
      expect(savedResumeResult(ctx.resumeAdmission)).toMatchObject({
        agentResumeRefused: 'chat-home',
        agentResumeUnavailable: true,
        savedResumeDecision: { verdict: 'chat-home', providerSession: { id: C } }
      })
      expect(forgetRefusedPaneResume).not.toHaveBeenCalled()
      expect(runtime.forgetRefusedSavedResume).not.toHaveBeenCalled()
    } finally {
      spawn.mockRestore()
    }
  })

  it('lets the actual lower-owned live result override a tentative fresh refusal', async () => {
    const runtime = chatHost()
    const ctx = freshContext(runtime)
    runtime.getTerminalLaunchResult.mockReturnValue({ launchAgent: 'codex' })
    const spawn = vi.spyOn(ctx.provider, 'spawn').mockResolvedValue({
      id: 'already-live',
      isReattach: true,
      launchAgent: 'codex'
    })
    try {
      await executePreparedSpawn(ctx)
      expect(ctx.result).toMatchObject({
        id: 'already-live',
        isReattach: true,
        launchAgent: 'codex'
      })
      expect(ctx.resumeAdmission).toBeNull()
      expect(runtime.forgetRefusedSavedResume).not.toHaveBeenCalled()
    } finally {
      spawn.mockRestore()
    }
  })

  it('checks the selected late cold-shell candidate but never checks a real reattach', async () => {
    const runtime = chatHost()
    const pane = { paneKey: 'tab-1:leaf', saved: undefined }
    await expect(
      admitColdRestoreReattach(
        runtime,
        { coldRestore: { scrollback: '', cwd: '/tmp' } },
        pane,
        null
      )
    ).resolves.toMatchObject({ verdict: 'chat-home', refused: { providerSession: { id: C } } })
    await expect(
      admitColdRestoreReattach(runtime, { coldRestore: {}, isReattach: true }, pane, null)
    ).resolves.toBeNull()
  })
})

it('unwinds a refused fresh claim before spawning an unclaimed shell', async () => {
  const runtime = chatHost()
  const ctx = createRuntimePtySpawnState(deps(runtime), {
    cols: 80,
    rows: 24,
    launchAgent: 'claude',
    command: `claude --resume ${C}`,
    resumeOrigin: 'saved',
    resumeProviderSession: { key: 'session_id', id: C },
    agentSessionEnsure: {
      claim: {
        agent: 'claude',
        digestVersion: 1,
        keyId: 'key',
        identityDigest: 'C',
        worktreeScopeDigest: 'scope'
      },
      surface: { worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf', terminalHandle: 'terminal' }
    }
  })
  const claim = ctx.args.agentSessionEnsure?.claim
  if (!claim) {
    throw new Error('missing fixture claim')
  }
  ctx.spawnOptions = {
    cols: 80,
    rows: 24,
    command: ctx.args.command,
    agentSessionEnsure: ctx.args.agentSessionEnsure
  }
  const inventory = vi.spyOn(owners, 'reconcileAgentSessionOwnerListings').mockResolvedValue()
  const spawn = vi.spyOn(ctx.provider, 'spawn').mockResolvedValue({ id: 'refused-shell' })
  try {
    await executePreparedSpawn(ctx)
    expect(spawn).toHaveBeenCalledOnce()
    expect(ctx.spawnOptions.command).toBeUndefined()
    expect(ctx.result.agentSessionEnsure).toBeUndefined()
    expect(owners.agentSessionOwners.find(claim)).toBeNull()
    expect(ctx.resumeAdmission).toMatchObject({ verdict: 'chat-home' })
  } finally {
    inventory.mockRestore()
    spawn.mockRestore()
  }
})

it('returns the committed runtime shell when exact saved-record persistence fails', async () => {
  const runtime = {
    ...chatHost(),
    registerPty: vi.fn(),
    noteTerminalSpawnCommand: vi.fn(),
    reflowHeadlessTerminalToPtyGrid: vi.fn(),
    forgetRefusedSavedResume: vi.fn(async () => {
      throw new Error('saved record disk full')
    })
  }
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const spawn = vi.spyOn(localProvider, 'spawn').mockResolvedValue({ id: 'cleanup-failed-shell' })
  const onResumeOutcome = vi.fn()
  try {
    const result = await spawnPtyFromRuntimeController(deps(runtime), {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      command: `claude --resume ${C}`,
      launchAgent: 'claude',
      resumeOrigin: 'saved',
      resumeProviderSession: { key: 'session_id', id: C },
      onResumeOutcome
    })
    expect(result).toMatchObject({ id: 'cleanup-failed-shell', agentResumeRefused: 'chat-home' })
    expect(spawn.mock.calls[0]?.[0].command).toBeUndefined()
    expect(runtime.registerPty).toHaveBeenCalled()
    expect(runtime.forgetRefusedSavedResume).toHaveBeenCalledOnce()
    expect(onResumeOutcome.mock.calls).toEqual(
      ORCA_LAYOUT_OWNER_IS_MAIN ? [['cleanup-failed-shell', 'resume-unavailable']] : []
    )
    await Promise.resolve()
    expect(warning).toHaveBeenCalled()
  } finally {
    spawn.mockRestore()
    warning.mockRestore()
  }
})

it('preserves case-distinct conversation heads and saved homes across the shared OpenCode family', async () => {
  const ids = ['ses_000000000001AAAAAAAAAAAAAA', 'ses_000000000001aaaaaaaaaaaaaa']
  const record = {
    ...chat,
    provider: 'opencode' as const,
    providerHandleChain: ids.map((nativeId, index) => ({
      ...chat.providerHandleChain[0]!,
      linkId: `case-${index}`,
      handle: { transport: 'acp' as const, agent: 'opencode' as const, nativeId }
    }))
  }
  const opencodeStore: AgentSessionRecordStore = Object.create(AgentSessionRecordStore.prototype)
  opencodeStore.listConversations = () => [agentSessionConversationView(record)]
  opencodeStore.getVisibleSessionTabIndex = () => ({
    present: true,
    sessionIds: [record.sessionId]
  })
  const runtime = { openAgentSessionRecordStore: async () => opencodeStore }
  expect(
    listStructuredProviderSessionOwnership([agentSessionConversationView(record)]).map(
      (holding) => holding.role
    )
  ).toEqual(['earlier', 'head'])
  for (const [index, id] of ids.entries()) {
    await expect(
      admitResumeSpawn(
        runtime,
        {
          launchAgent: 'opencode2',
          resumeOrigin: 'saved',
          resumeProviderSession: { key: 'session_id', id }
        },
        null
      )
    ).resolves.toMatchObject({ verdict: index === 0 ? 'admitted' : 'chat-home' })
  }
})

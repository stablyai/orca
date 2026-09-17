import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionHandoffDirection,
  AgentSessionHandoffRequest,
  AgentSessionMutationEnvelope
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionPermissionMode } from '../../../shared/structured-agent-session-permission-mode'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import type {
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

const CALLER = { callerKey: 'client-1' }
const PROVIDER_SESSION_ID = '661a0f5d-6f2e-4553-a49d-25cc113e7f5c'
const BASE_PERMISSION_MODE = 'acceptEdits'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let transcriptPath: string
let currentPermissionMode: StructuredAgentSessionPermissionMode
let acquisitionOptions: (Readonly<Record<string, string>> | undefined)[]
let recordOptionsAtAcquire: (Readonly<Record<string, string>> | undefined)[]

function envelope(method: string, fields: Record<string, unknown>): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

function handoff(direction: AgentSessionHandoffDirection): AgentSessionHandoffRequest {
  const fields = { direction, mode: 'now' as const, action: 'start' as const }
  return { envelope: envelope('agentSession.requestHandoff', fields), ...fields }
}

function tuiOwner(fence: number, spawnToken: string): StructuredTuiOwner {
  return {
    terminal: { handle: 'term-tui', tabId: 'tab-tui', paneKey: 'pane-tui', ptyId: 'pty-tui' },
    process: {
      hostId: 'local',
      pid: 5200,
      processStartTimeMs: NOW,
      spawnToken
    },
    link: {
      linkId: `tui-link-${fence}`,
      handle: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: 'tui-leaf' },
      origin: 'resumed',
      mintedAtFence: fence,
      observedAt: NOW
    },
    transcriptPath
  }
}

function handoffTransport(): StructuredAgentSessionHandoffTransport {
  return {
    hostLabel: 'Test host',
    launchTui: async ({ record, fence, spawnToken }) => {
      const requested = record.options?.permissionMode
      if (requested === 'plan' || requested === BASE_PERMISSION_MODE) {
        currentPermissionMode = requested
      }
      return tuiOwner(fence, spawnToken)
    },
    reproveTuiOwner: async ({ owner }) => owner,
    recoverTuiOwner: async (record) =>
      tuiOwner(
        record.lease.runtimeFence,
        record.lease.ownerProcess?.spawnToken ?? record.lease.reservedSpawnToken ?? 'recovered'
      ),
    stopRecoveredOwner: async () => undefined,
    closeTuiOwner: async (owner) => ({ transcriptPath: owner.transcriptPath }),
    waitForTuiExit: async (owner) => ({ transcriptPath: owner.transcriptPath }),
    waitForTuiIdleOrExit: async () => 'idle',
    tuiStatus: () => 'idle'
  }
}

function adapter(): StructuredAgentSessionAdapter {
  return {
    acquire: vi.fn<StructuredAgentSessionAdapter['acquire']>(
      async ({ fence, spawnToken, options }) => {
        acquisitionOptions.push(options)
        recordOptionsAtAcquire.push(store.getRecord(SESSION)?.options)
        if (
          options?.permissionMode === 'plan' ||
          options?.permissionMode === BASE_PERMISSION_MODE
        ) {
          currentPermissionMode = options.permissionMode
        }
        return {
          process: {
            hostId: 'local',
            pid: 4200 + acquisitionOptions.length,
            processStartTimeMs: NOW,
            spawnToken
          },
          link: {
            linkId: `native-link-${fence}`,
            handle: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: 'native-leaf' },
            origin: acquisitionOptions.length === 1 ? 'created' : 'resumed',
            mintedAtFence: fence,
            observedAt: NOW
          }
        }
      }
    ),
    readOptions: vi.fn<NonNullable<StructuredAgentSessionAdapter['readOptions']>>(async () => ({
      models: [{ id: 'claude-sonnet', label: 'Sonnet', isDefault: true, efforts: [] }],
      permissionModeRestoreValue: BASE_PERMISSION_MODE,
      current: {
        model: 'claude-sonnet',
        permissionMode: currentPermissionMode,
        confirmed: ['model', 'permissionMode']
      }
    })),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: vi.fn(async () => undefined),
    setOption: vi.fn(async () => ({ model: 'claude-sonnet' })),
    closeSession: vi.fn(async () => true)
  }
}

async function waitForOwner(owner: 'native' | 'tui'): Promise<void> {
  await vi.waitFor(async () => expect(await host.handoffStatus(SESSION)).toMatchObject({ owner }), {
    timeout: 5000
  })
}

async function replacePermissionMode(permissionMode: 'plan'): Promise<void> {
  const record = store.getRecord(SESSION)!
  await store.replaceSessionOptions({
    sessionId: SESSION,
    fence: record.lease.runtimeFence,
    options: { permissionMode },
    now: NOW
  })
}

async function writePermissionModes(
  modes: readonly StructuredAgentSessionPermissionMode[],
  sessionId = PROVIDER_SESSION_ID
): Promise<void> {
  await writeFile(
    transcriptPath,
    `${modes
      .map((permissionMode) =>
        JSON.stringify({ type: 'permission-mode', permissionMode, sessionId })
      )
      .join('\n')}\n`,
    'utf8'
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-handoff-claude-permission-'))
  resetHostTestOperationIds()
  currentPermissionMode = BASE_PERMISSION_MODE
  acquisitionOptions = []
  recordOptionsAtAcquire = []
  const accountHome = join(root, 'claude-home')
  const projectsDir = join(accountHome, 'projects', 'workspace')
  transcriptPath = join(projectsDir, `${PROVIDER_SESSION_ID}.jsonl`)
  await mkdir(projectsDir, { recursive: true })
  await writeFile(transcriptPath, '', 'utf8')
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-native',
    handoffTransport: handoffTransport(),
    now: () => NOW
  })
  const attached = await host.attach(
    CALLER,
    hostTestAttachParams(null, {
      provider: 'claude',
      agent: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: accountHome },
      providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: 'native-leaf' }
    })
  )
  expect(attached).toMatchObject({ ok: true })
  expect(store.getRecord(SESSION)?.permissionModeRestoreValue).toBe(BASE_PERMISSION_MODE)
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('Claude TUI permission handoff', () => {
  it('persists Plan observed from the exited TUI before native acquisition', async () => {
    expect(await host.requestHandoff(CALLER, handoff('to-tui'))).toMatchObject({ ok: true })
    await waitForOwner('tui')
    currentPermissionMode = 'plan'
    await writePermissionModes([BASE_PERMISSION_MODE, 'plan'])

    expect(await host.requestHandoff(CALLER, handoff('to-native'))).toMatchObject({ ok: true })
    await waitForOwner('native')

    expect(recordOptionsAtAcquire[1]).toEqual({
      model: 'claude-sonnet',
      permissionMode: 'plan'
    })
    expect(acquisitionOptions[1]).toEqual({ model: 'claude-sonnet' })
    expect(store.getRecord(SESSION)).toMatchObject({
      options: { model: 'claude-sonnet', permissionMode: 'plan' },
      permissionModeRestoreValue: BASE_PERMISSION_MODE
    })
  })

  it('adopts Plan from a pre-baseline TUI record', async () => {
    await store.transitionHandoff(SESSION, (record) => {
      const { permissionModeRestoreValue: _permissionModeRestoreValue, ...withoutBaseline } = record
      return withoutBaseline
    })
    expect(await host.requestHandoff(CALLER, handoff('to-tui'))).toMatchObject({ ok: true })
    await waitForOwner('tui')
    currentPermissionMode = 'plan'
    await writePermissionModes(['plan'])

    expect(await host.requestHandoff(CALLER, handoff('to-native'))).toMatchObject({ ok: true })
    await waitForOwner('native')

    expect(recordOptionsAtAcquire[1]).toEqual({
      model: 'claude-sonnet',
      permissionMode: 'plan'
    })
    expect(acquisitionOptions[1]).toEqual({ model: 'claude-sonnet' })
    expect(store.getRecord(SESSION)).toMatchObject({
      options: { model: 'claude-sonnet', permissionMode: 'plan' },
      permissionModeRestoreValue: BASE_PERMISSION_MODE
    })
  })

  it('falls back to provider Plan for a pre-baseline record without transcript proof', async () => {
    await store.transitionHandoff(SESSION, (record) => {
      const { permissionModeRestoreValue: _permissionModeRestoreValue, ...withoutBaseline } = record
      return withoutBaseline
    })
    expect(await host.requestHandoff(CALLER, handoff('to-tui'))).toMatchObject({ ok: true })
    await waitForOwner('tui')
    currentPermissionMode = 'plan'
    await writePermissionModes(['plan'], 'different-session')

    expect(await host.requestHandoff(CALLER, handoff('to-native'))).toMatchObject({ ok: true })
    await waitForOwner('native')

    expect(recordOptionsAtAcquire[1]).toEqual({ model: 'claude-sonnet' })
    expect(acquisitionOptions[1]).toEqual({ model: 'claude-sonnet' })
    expect(store.getRecord(SESSION)).toMatchObject({
      options: { model: 'claude-sonnet', permissionMode: 'plan' },
      permissionModeRestoreValue: BASE_PERMISSION_MODE
    })
  })

  it('removes stale Plan after the exited TUI restored the immutable base', async () => {
    await replacePermissionMode('plan')
    currentPermissionMode = 'plan'
    expect(await host.requestHandoff(CALLER, handoff('to-tui'))).toMatchObject({ ok: true })
    await waitForOwner('tui')
    currentPermissionMode = BASE_PERMISSION_MODE
    await writePermissionModes(['plan', BASE_PERMISSION_MODE])

    expect(await host.requestHandoff(CALLER, handoff('to-native'))).toMatchObject({ ok: true })
    await waitForOwner('native')

    expect(recordOptionsAtAcquire[1]).toEqual({})
    expect(acquisitionOptions[1]).toEqual({})
    expect(store.getRecord(SESSION)).toMatchObject({
      options: {},
      permissionModeRestoreValue: BASE_PERMISSION_MODE
    })
  })

  it('falls back to the resumed provider report when the transcript has no exact proof', async () => {
    await replacePermissionMode('plan')
    currentPermissionMode = 'plan'
    expect(await host.requestHandoff(CALLER, handoff('to-tui'))).toMatchObject({ ok: true })
    await waitForOwner('tui')
    currentPermissionMode = BASE_PERMISSION_MODE
    await writePermissionModes(['plan'], 'different-session')

    expect(await host.requestHandoff(CALLER, handoff('to-native'))).toMatchObject({ ok: true })
    await waitForOwner('native')

    expect(recordOptionsAtAcquire[1]).toEqual({ permissionMode: 'plan' })
    expect(acquisitionOptions[1]).toEqual({})
    expect(store.getRecord(SESSION)?.options).toEqual({ model: 'claude-sonnet' })
  })
})

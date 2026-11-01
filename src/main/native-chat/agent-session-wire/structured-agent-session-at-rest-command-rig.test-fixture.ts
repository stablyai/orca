// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react'

import type { CommandMenuRendererFixtureModule } from '../../../shared/agent-session-command-menu.test-fixture-contract'

import { OMP } from '../../acp/acp-command-discovery.test-fixture'
import { acpStructuredAgentDefinition } from '../../acp/acp-structured-agent-definitions'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { StructuredAgentRegistry } from './structured-agent-registry'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'
import { structuredAgentsDeclaringNothing } from './structured-agent-session-adapter-router-test-support'
import type { StructuredAgentSessionAtRestCommands } from './structured-agent-session-at-rest-commands'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, vi, type Mock } from 'vitest'
import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import {
  ClaudeAtRestCommandCatalog,
  type ClaudeAtRestCommandsDeps
} from '../../claude/claude-at-rest-commands'

import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const runtimeMocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: runtimeMocks.call,
  subscribeStructuredAgentSession: runtimeMocks.subscribe
}))
export const runtime: { call: Mock; subscribe: Mock } = runtimeMocks
export const renderer = await vi.importActual<CommandMenuRendererFixtureModule>(
  '../../../renderer/src/components/native-chat/agent-session-command-menu.test-fixture'
)
export const caller = { callerKey: 'desktop' }
export const CLAUDE_SESSION = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'

export let directory: string
export let workspace: string
export let account: string
export let clock: number
export let store: AgentSessionRecordStore
export let host: StructuredAgentSessionHost
export let deliveryAdapter: StructuredAgentSessionAdapterRouter

export function adapter(
  catalog: StructuredAgentSessionAtRestCommands
): StructuredAgentSessionAdapter {
  return {
    supportsLocation: () => true,
    supportsCreate: () => true,
    open: async () => ({ reportedOptions: {} }),
    acquire: vi.fn(async (input) => ({
      acquisitionGeneration: `generation-${input.fence}`,
      process: {
        hostId: 'local',
        pid: 4001,
        processStartTimeMs: HOST_TEST_NOW,
        spawnToken: input.spawnToken
      },
      link: {
        linkId: `link-${input.fence}`,
        mintedAtFence: input.fence,
        observedAt: HOST_TEST_NOW,
        origin: 'created' as const,
        handle: claudeProviderHandle(CLAUDE_SESSION, null)
      }
    })),
    atRestCommands: catalog,
    dispatch: vi.fn(async () => ({ state: 'unknown' as const, reason: 'test' })),
    cancelTurn: async () => ({ cancelled: true }),
    answerPrompt: async () => {},
    setOption: async () => {},
    releaseAcquisition: async () => true,
    closeSession: async () => true
  }
}

// Isolate discovery to test folders; a large real home otherwise outlasts the menu wait.
export const discoverWithoutUserHome: ClaudeAtRestCommandsDeps['discover'] = async (args) => {
  const { discoverSkills } = await import('../../skills/discovery')
  return discoverSkills({ ...args, homeDir: join(directory, 'home'), refresh: true })
}

export function catalogFor(workspacePath: string): ClaudeAtRestCommandCatalog {
  return new ClaudeAtRestCommandCatalog({
    resolveWorkspacePath: async () => workspacePath,
    now: () => clock,
    discover: discoverWithoutUserHome
  })
}

export async function openHost(
  catalog: StructuredAgentSessionAtRestCommands | null = catalogFor(workspace)
): Promise<void> {
  const implementation = adapter(catalog ?? { read: () => undefined, onChange: () => () => {} })
  if (catalog === null) {
    implementation.atRestCommands = undefined
  }
  const agents = new StructuredAgentRegistry(
    structuredAgentsDeclaringNothing([CLAUDE_STRUCTURED_AGENT, acpStructuredAgentDefinition(OMP)])
      .definitions()
      .map((definition) => ({ definition, adapter: implementation }))
  )
  store = await openTestAgentSessionRecordStore(directory)
  deliveryAdapter = new StructuredAgentSessionAdapterRouter(agents, async () => {})
  host = new StructuredAgentSessionHost({
    agents,
    store,
    adapter: deliveryAdapter,
    journalDatabase: openTestJournalHostDatabase(directory),
    claimKeyId: 'key',
    logger: recordingStructuredAgentSessionLogger().logger,
    now: () => clock,
    probeOwner: async () => ({ outcome: 'pid-absent' })
  })
}

export async function writeSkill(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: A skill\n---\n`)
}

export async function writeCommand(root: string, file: string): Promise<void> {
  await mkdir(join(root, file, '..'), { recursive: true })
  await writeFile(join(root, file), '---\ndescription: A command\n---\nDo it.\n')
}

export async function menuOf(sessionId: string): Promise<AgentSessionSlashCommand[] | null> {
  let commands: AgentSessionSlashCommand[] | null | undefined
  const emit = (event: AgentSessionSubscribeEvent) => {
    if ('commands' in event) {
      commands = event.commands
    }
  }
  const unsubscribe = await host.subscribe({ id: `pane-${sessionId}`, sessionId, emit })
  await vi.waitFor(() => expect(commands).toBeTruthy())
  unsubscribe()
  return commands ?? null
}

export const namesOf = (menu: AgentSessionSlashCommand[] | null, kind: 'skill' | 'command') =>
  (menu ?? []).filter((entry) => entry.kind === kind).map((entry) => entry.name)

beforeEach(async () => {
  resetHostTestOperationIds()
  clock = HOST_TEST_NOW
  directory = await mkdtemp(join(tmpdir(), 'orca-at-rest-commands-'))
  workspace = join(directory, 'workspace')
  account = join(directory, 'claude-account')
  await writeSkill(join(workspace, '.claude', 'skills'), 'review-pr')
  await writeCommand(join(account, 'commands'), 'deploy.md')
  await openHost()
  const attached = await host.attach(
    caller,
    hostTestAttachParams(null, {
      provider: 'claude',
      agent: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: account },
      providerHandle: { kind: 'claude', sessionId: CLAUDE_SESSION, leafUuid: null }
    })
  )
  expect(attached).toMatchObject({ ok: true })
  await host.setSessionTabVisibility(SESSION, true)
})

afterEach(async () => {
  cleanup()
  renderer.resetReadOwners()
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

export async function attachContext(provider: 'claude' | 'omp', index: number): Promise<string> {
  const sessionId = crypto.randomUUID()
  if (provider === 'omp') {
    await store.reserveOwner({
      sessionId,
      provider,
      location: { ...store.getRecord(SESSION)!.location, workspaceId: `workspace-${index}` },
      accountHome: { variable: 'PI_CODING_AGENT_DIR', path: account },
      expectedFence: null,
      spawnToken: crypto.randomUUID(),
      claimKeyId: 'key',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' },
      operation: { callerKey: 'test', operationId: hostTestOperationId(), fingerprint: sessionId },
      now: clock
    })
    return sessionId
  }
  const attached = await host.attach(
    caller,
    hostTestAttachParams(null, {
      envelope: { ...hostTestAttachParams(null).envelope, sessionId },
      provider,
      agent: provider,
      accountHome:
        provider === 'claude'
          ? { variable: 'CLAUDE_CONFIG_DIR', path: account }
          : { variable: 'PI_CODING_AGENT_DIR', path: account },
      location: { ...store.getRecord(SESSION)!.location, workspaceId: `workspace-${index}` },
      providerHandle: { kind: 'claude', sessionId: crypto.randomUUID(), leafUuid: null }
    })
  )
  if (!attached.ok) {
    throw new Error(JSON.stringify(attached))
  }
  return sessionId
}

export const advanceCatalogClock = (milliseconds: number): void => {
  clock += milliseconds
}
export const setCatalogAccount = (path: string): void => {
  account = path
}

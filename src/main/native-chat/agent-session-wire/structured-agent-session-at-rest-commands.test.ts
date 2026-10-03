// A Claude chat whose Claude is not running offers the `/` commands and skills Claude would read
// from its folders on the host that runs it: after a /clear, after a relaunch, as files change.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import {
  CLAUDE_AT_REST_COMMANDS_TTL_MS,
  ClaudeAtRestCommandCatalog
} from '../../claude/claude-at-rest-commands'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const caller = { callerKey: 'desktop' }
const CLAUDE_SESSION = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'

let directory: string
let workspace: string
let account: string
let clock: number
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost

/** Claude is never running here, so the only `/` surface is the one read from its folders. */
function adapter(catalog: ClaudeAtRestCommandCatalog): StructuredAgentSessionAdapter {
  return {
    supportsLocation: () => true,
    supportsCreate: () => true,
    acquire: vi.fn(async (input) => ({
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

function catalogFor(workspacePath: string): ClaudeAtRestCommandCatalog {
  return new ClaudeAtRestCommandCatalog({
    resolveWorkspacePath: async () => workspacePath,
    now: () => clock,
    // Only the folders this test writes, never the machine's own home.
    discover: async (args) => {
      const { discoverSkills } = await import('../../skills/discovery')
      return discoverSkills({ ...args, homeDir: join(directory, 'home'), refresh: true })
    }
  })
}

async function openHost(catalog = catalogFor(workspace)): Promise<void> {
  store = await openTestAgentSessionRecordStore(directory)
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(catalog),
    journalDatabase: openTestJournalHostDatabase(directory),
    claimKeyId: 'key',
    logger: recordingStructuredAgentSessionLogger().logger,
    now: () => clock,
    probeOwner: async () => ({ outcome: 'pid-absent' })
  })
}

async function writeSkill(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: A skill\n---\n`)
}

async function writeCommand(root: string, file: string): Promise<void> {
  await mkdir(join(root, file, '..'), { recursive: true })
  await writeFile(join(root, file), '---\ndescription: A command\n---\nDo it.\n')
}

/** The `/` surface a pane subscribed to `sessionId` shows once the scan has landed. */
async function menuOf(sessionId: string): Promise<AgentSessionSlashCommand[] | null> {
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

const namesOf = (menu: AgentSessionSlashCommand[] | null, kind: 'skill' | 'command') =>
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
  await host.flushAllStreamedEvents()
  await rm(directory, { recursive: true, force: true })
})

describe("a Claude chat whose Claude isn't running shows the `/` surface from its folders", () => {
  it('after /clear, before the new chat has started', async () => {
    const cleared = await host.conversationCommand(caller, {
      command: 'clear',
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.conversationCommand',
          sessionId: SESSION,
          fields: { command: 'clear' }
        })
      }
    })
    const replacement = cleared.ok ? cleared.value.replacementSessionId! : ''
    const menu = await menuOf(replacement)
    expect(namesOf(menu, 'skill')).toEqual(['review-pr'])
    // Everything the menu offered before a list existed, then what the folders add.
    expect(namesOf(menu, 'command')).toEqual(['model', 'effort', 'clear', 'compact', 'deploy'])
  })

  it('keeps a slow scan once it answers, never a staler one after a newer, and runs at most two', async () => {
    const pending: ((skills: string[]) => void)[] = []
    const catalog = new ClaudeAtRestCommandCatalog({
      resolveWorkspacePath: async () => workspace,
      now: () => clock,
      discover: () =>
        new Promise((resolve) => {
          pending.push((names) =>
            resolve({
              skills: names.map((name) => ({
                id: name,
                name,
                description: null,
                providers: ['claude'],
                sourceKind: 'repo',
                sourceLabel: 'repo',
                rootPath: workspace,
                directoryPath: workspace,
                skillFilePath: workspace,
                installed: true,
                updatedAt: null
              })),
              sources: [],
              scannedAt: clock
            })
          )
        })
    })
    const record = store.getRecord(SESSION)!
    const skills = () => namesOf(catalog.read(record) ?? null, 'skill')
    const changed = vi.fn()
    catalog.onChange(changed)
    catalog.read(record)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    // Overdue: a second scan starts beside the first; a third never does while both run.
    clock += 30_000
    catalog.read(record)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    clock += 30_000
    catalog.read(record)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pending).toHaveLength(2)
    // The second answers first; the first, older one landing after it changes nothing.
    pending[1](['newer'])
    await vi.waitFor(() => expect(skills()).toEqual(['newer']))
    pending[0](['older'])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(skills()).toEqual(['newer'])
    expect(changed).toHaveBeenCalledTimes(1)
    // A slow scan is not thrown away: the next one, however long it takes, is kept.
    clock += CLAUDE_AT_REST_COMMANDS_TTL_MS
    catalog.read(record)
    await vi.waitFor(() => expect(pending).toHaveLength(3))
    clock += 35_000
    pending[2](['slow'])
    await vi.waitFor(() => expect(skills()).toEqual(['slow']))
  })

  it('waits out the window from when a scan lands, even one that failed', async () => {
    let calls = 0
    let failNext = true
    const catalog = new ClaudeAtRestCommandCatalog({
      resolveWorkspacePath: async () => workspace,
      now: () => clock,
      discover: async (args) => {
        calls += 1
        // Each scan takes 15 s of the clock, longer than the window.
        clock += 15_000
        if (failNext) {
          failNext = false
          throw new Error('unreadable')
        }
        const { discoverSkills } = await import('../../skills/discovery')
        return discoverSkills({ ...args, homeDir: join(directory, 'home'), refresh: true })
      }
    })
    const record = store.getRecord(SESSION)!
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      catalog.read(record)
      await vi.waitFor(() => expect(warned).toHaveBeenCalledOnce())
      catalog.read(record)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(calls).toBe(1)
      clock += CLAUDE_AT_REST_COMMANDS_TTL_MS
      catalog.read(record)
      await vi.waitFor(() =>
        expect(namesOf(catalog.read(record) ?? null, 'skill')).toEqual(['review-pr'])
      )
      clock += CLAUDE_AT_REST_COMMANDS_TTL_MS - 1
      catalog.read(record)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(calls).toBe(2)
    } finally {
      warned.mockRestore()
    }
  })

  it('after a relaunch, with nothing remembered from before it', async () => {
    await host.flushAllStreamedEvents()
    await openHost()
    const menu = await menuOf(SESSION)
    expect(namesOf(menu, 'skill')).toEqual(['review-pr'])
    expect(namesOf(menu, 'command')).toContain('deploy')
  })

  it('with a command added on disk, pushed to a pane already showing the chat', async () => {
    let commands: AgentSessionSlashCommand[] | null | undefined
    await host.subscribe({
      id: 'pane',
      sessionId: SESSION,
      emit: (event) => {
        if ('commands' in event) {
          commands = event.commands
        }
      }
    })
    await vi.waitFor(() => expect(namesOf(commands ?? null, 'command')).toContain('deploy'))
    await writeCommand(join(workspace, '.claude', 'commands'), 'frontend/test.md')
    clock += CLAUDE_AT_REST_COMMANDS_TTL_MS
    // Anything that reads the surface after the window scans again; the pane is told the answer.
    host.readCommands(SESSION)
    await vi.waitFor(() =>
      expect(namesOf(commands ?? null, 'command')).toEqual(
        expect.arrayContaining(['deploy', 'frontend:test'])
      )
    )
  })

  it('from the folders of the host that runs it, never another host’s', async () => {
    const remoteWorkspace = join(directory, 'remote-workspace')
    await writeSkill(join(remoteWorkspace, '.claude', 'skills'), 'remote-only')
    const remote = catalogFor(remoteWorkspace)
    const record = store.getRecord(SESSION)!
    remote.read(record)
    await vi.waitFor(() =>
      expect(namesOf(remote.read(record) ?? null, 'skill')).toEqual(['remote-only'])
    )
    // A chat this host does not run is answered by nothing here, not by this host's folders.
    const local = catalogFor(workspace)
    const elsewhere = {
      ...record,
      location: { ...HOST_TEST_LOCATION, executionHostId: 'ssh:box' as const }
    }
    local.read(elsewhere)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(local.read(elsewhere)).toBeUndefined()
  })
})

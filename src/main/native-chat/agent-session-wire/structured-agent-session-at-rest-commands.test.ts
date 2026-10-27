import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import {
  CLAUDE_AT_REST_COMMANDS_TTL_MS,
  ClaudeAtRestCommandCatalog
} from '../../claude/claude-at-rest-commands'
import { createClaudeCommandCatalogProbe } from '../../claude/claude-command-catalog-probe'
import type { runAgentModelCatalogListing } from '../agent-model-catalog/agent-model-catalog-probe-runner'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

type ListingCall = Parameters<typeof runAgentModelCatalogListing>

const caller = { callerKey: 'desktop' }
const CLAUDE_SESSION = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'

let directory: string
let workspace: string
let account: string
let clock: number
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost

function adapter(catalog: ClaudeAtRestCommandCatalog): StructuredAgentSessionAdapter {
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

function catalogFor(workspacePath: string): ClaudeAtRestCommandCatalog {
  return new ClaudeAtRestCommandCatalog({
    resolveWorkspacePath: async () => workspacePath,
    now: () => clock,
    // Isolate discovery to test folders, excluding the user’s home.
    discover: async (args) => {
      const { discoverSkills } = await import('../../skills/discovery')
      return discoverSkills({ ...args, homeDir: join(directory, 'home'), refresh: true })
    }
  })
}

async function openHost(catalog = catalogFor(workspace)): Promise<void> {
  store = await openTestAgentSessionRecordStore(directory)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
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

describe("a Claude chat whose Claude isn't running lists Claude's own `/` commands", () => {
  it('as Claude itself lists it in the chat’s folder, from the folders until it can, and keeps its list through a failed refresh', async () => {
    const asked: ListingCall[] = []
    const failed = '{"type":"control_response","response":{"subtype":"error"}}\n'
    const listed = `${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'orca-command-discovery',
        response: {
          commands: [
            { name: 'goal', description: 'Set a goal', argumentHint: '', builtin: true },
            { name: 'review-pr', description: 'A skill (project)', argumentHint: '' }
          ]
        }
      }
    })}\n`
    let answer: string | Promise<string> = failed
    const probe = createClaudeCommandCatalogProbe({
      resolveCommand: () => 'claude',
      resolveInheritedEnv: async () => ({ PATH: '/bin' }),
      resolveAuthPolicy: () => ({ account: 'system' }),
      runListing: async (...call) => {
        asked.push(call)
        return answer
      }
    })
    const catalog = new ClaudeAtRestCommandCatalog({
      resolveWorkspacePath: async () => workspace,
      now: () => clock,
      probe
    })
    const record = () => store.getRecord(SESSION)!
    const commandNames = () => namesOf(catalog.read(record()) ?? null, 'command')
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await host.flushAllStreamedEvents()
      await openHost(catalog)
      expect(namesOf(await menuOf(SESSION), 'command')).toEqual([
        'model',
        'effort',
        'clear',
        'compact',
        'deploy'
      ])
      const success = Promise.withResolvers<string>()
      const failure = Promise.withResolvers<string>()
      answer = success.promise
      clock += CLAUDE_AT_REST_COMMANDS_TTL_MS
      host.readCommands(SESSION)
      await vi.waitFor(() => expect(asked).toHaveLength(2))
      // Start overlapping scans before the newer result falls back.
      answer = failure.promise
      clock += 30_000
      host.readCommands(SESSION)
      await vi.waitFor(() => expect(asked).toHaveLength(3))
      success.resolve(listed)
      await vi.waitFor(() => expect(commandNames()).toContain('goal'))
      const claudeList = catalog.read(record())
      expect(claudeList?.find((entry) => entry.name === 'goal')).toMatchObject({
        kind: 'command',
        description: 'Set a goal'
      })
      expect(asked[0]?.[0]).toMatchObject({ cwd: workspace })
      expect(asked[0]?.[1].inheritedEnv?.CLAUDE_CONFIG_DIR).toBe(account)
      failure.resolve(failed)
      await vi.waitFor(() => expect(warned).toHaveBeenCalledTimes(2))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(catalog.read(record())).toEqual(claudeList)
      // Failed refresh must retain the provider list over folder fallback.
      answer = failed
      clock += CLAUDE_AT_REST_COMMANDS_TTL_MS
      host.readCommands(SESSION)
      await vi.waitFor(() => expect(asked).toHaveLength(4))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(catalog.read(record())).toEqual(claudeList)
    } finally {
      warned.mockRestore()
    }
  })

  it('does not let a rejected fallback discard an overlapping Claude refresh', async () => {
    const listed = (name: string) =>
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'orca-command-discovery',
          response: { commands: [{ name, description: name, argumentHint: '', builtin: true }] }
        }
      })}\n`
    const pending = Promise.withResolvers<string>()
    const fallback = Promise.withResolvers<void>()
    const fallbackDone = Promise.withResolvers<void>()
    let fallbackStarted = false
    let answers: (string | Promise<string>)[] = [listed('first'), pending.promise, 'bad']
    const asked: ListingCall[] = []
    const probe = createClaudeCommandCatalogProbe({
      resolveCommand: () => 'claude',
      resolveInheritedEnv: async () => ({ PATH: '/bin' }),
      resolveAuthPolicy: () => ({ account: 'system' }),
      runListing: async (...call) => {
        asked.push(call)
        return answers.shift() ?? 'bad'
      }
    })
    const catalog = new ClaudeAtRestCommandCatalog({
      resolveWorkspacePath: async () => workspace,
      now: () => clock,
      probe,
      discover: async (args) => {
        if (answers.length === 0) {
          fallbackStarted = true
          await fallback.promise
        }
        const { discoverSkills } = await import('../../skills/discovery')
        const result = await discoverSkills({
          ...args,
          homeDir: join(directory, 'home'),
          refresh: true
        })
        if (fallbackStarted) {
          fallbackDone.resolve()
        }
        return result
      }
    })
    const record = store.getRecord(SESSION)!
    const commandNames = () => namesOf(catalog.read(record) ?? null, 'command')
    catalog.read(record)
    await vi.waitFor(() => expect(commandNames()).toContain('first'))
    clock += CLAUDE_AT_REST_COMMANDS_TTL_MS
    catalog.read(record)
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    clock += 30_000
    catalog.read(record)
    await vi.waitFor(() => expect(asked).toHaveLength(3))
    await vi.waitFor(() => expect(fallbackStarted).toBe(true))
    clock -= 30_000
    fallback.resolve()
    await fallbackDone.promise
    expect(commandNames()).toContain('first')
    pending.resolve(listed('second'))
    await vi.waitFor(() => expect(commandNames()).toContain('second'))

    const settledCalls = asked.length
    answers = ['bad']
    clock += CLAUDE_AT_REST_COMMANDS_TTL_MS
    catalog.read(record)
    await vi.waitFor(() => expect(asked).toHaveLength(settledCalls + 1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    clock += CLAUDE_AT_REST_COMMANDS_TTL_MS - 1
    catalog.read(record)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(asked).toHaveLength(settledCalls + 1)
  })
})

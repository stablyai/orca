import { createCodexAtRestSkillCatalog } from '../../codex/codex-at-rest-skills-probe'
import { refreshAtRestCommandContext } from './at-rest-command-context'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
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
      answer = success.promise
      clock += CLAUDE_AT_REST_COMMANDS_TTL_MS
      host.readCommands(SESSION)
      await vi.waitFor(() => expect(asked).toHaveLength(2))
      // A slow refresh is joined, not doubled, however long it runs.
      clock += 30_000
      host.readCommands(SESSION)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(asked).toHaveLength(2)
      success.resolve(listed)
      await vi.waitFor(() => expect(commandNames()).toContain('goal'))
      const claudeList = catalog.read(record())
      expect(claudeList?.find((entry) => entry.name === 'goal')).toMatchObject({
        kind: 'command',
        description: 'Set a goal'
      })
      expect(asked[0]?.[0]).toMatchObject({ cwd: workspace })
      expect(asked[0]?.[1].inheritedEnv?.CLAUDE_CONFIG_DIR).toBe(account)
      // Failed refresh must retain the provider list over folder fallback.
      answer = failed
      clock += CLAUDE_AT_REST_COMMANDS_TTL_MS
      host.readCommands(SESSION)
      await vi.waitFor(() => expect(warned).toHaveBeenCalledTimes(2))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(asked).toHaveLength(3)
      expect(catalog.read(record())).toEqual(claudeList)
      // The folder answer still counts as this TTL's scan.
      clock += CLAUDE_AT_REST_COMMANDS_TTL_MS - 1
      host.readCommands(SESSION)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(asked).toHaveLength(3)
    } finally {
      warned.mockRestore()
    }
  })
  it('cancels source preparation, fallback and close before any late work', async () => {
    vi.useFakeTimers()
    const listed = (name: string) =>
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'orca-command-discovery',
          response: { commands: [{ name, description: name, argumentHint: '', builtin: true }] }
        }
      })}\n`
    let pending = Promise.withResolvers<string>()
    let fallback = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>()
    let stage = '',
      blocked = false
    const block = async <T>(at: string, value: T): Promise<T> => {
      if (stage.endsWith(at) && !blocked) {
        blocked = true
        entered.resolve()
        await pending.promise
      }
      return value
    }
    const asked: unknown[][] = []
    const probe = createClaudeCommandCatalogProbe({
      resolveCommand: () => 'claude',
      resolveInheritedEnv: () => block('environment', { PATH: '/bin' }),
      resolveAuthPolicy: () => ({ account: 'system' }),
      runListing: async (...call) => {
        asked.push(call)
        if (stage.endsWith('fallback') && !blocked) {
          throw new Error('CLI failed')
        }
        if (stage.endsWith('close') && !blocked) {
          entered.resolve()
          try {
            await waitForPromiseWithSignal(pending.promise, call[1].signal)
          } finally {
            await fallback.promise
          }
        }
        return listed('recovered')
      }
    })
    const emptyDiscovery = { skills: [], sources: [], scannedAt: 0 }
    const claude = new ClaudeAtRestCommandCatalog({
      resolveWorkspacePath: async () => workspace,
      probe,
      discover: async (args) =>
        waitForPromiseWithSignal(block('fallback', emptyDiscovery), args.signal)
    })
    const codex = createCodexAtRestSkillCatalog({
      resolveWorkspacePath: () => block('workspace', workspace),
      resolveEnvironment: () => block('environment', { PATH: '/bin' }),
      resolveLaunchArgs: () => block('arguments', []),
      resolveCommand: () => '/bin/codex',
      runSession: async (invocation, body) => {
        asked.push([invocation])
        return body({
          request: async () => ({ data: [{ cwd: workspace, skills: [] }] }),
          notify: () => {}
        })
      }
    })
    const record = store.getRecord(SESSION)!
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      for (stage of [
        'codex/readiness',
        'codex/workspace',
        'codex/environment',
        'codex/arguments',
        'claude/environment',
        'claude/fallback',
        'claude/close'
      ]) {
        pending = Promise.withResolvers<string>()
        fallback = Promise.withResolvers<void>()
        entered = Promise.withResolvers<void>()
        blocked = false
        const provider = stage.startsWith('codex') ? ('codex' as const) : ('claude' as const)
        const catalog = provider === 'codex' ? codex : claude
        const chat = { ...record, provider }
        const ready = stage.endsWith('readiness')
          ? refreshAtRestCommandContext(() => block('readiness', undefined))
          : Promise.resolve()
        catalog.retireContext()
        const starting = asked.length
        catalog.read(chat)
        await entered.promise
        if (stage.endsWith('close')) {
          for (const workspaceId of ['two', 'three']) {
            catalog.read({ ...chat, location: { ...chat.location, workspaceId } })
          }
          await vi.waitFor(() => expect(asked).toHaveLength(starting + 2))
        }
        await vi.advanceTimersByTimeAsync(300_000)
        const before = asked.length
        blocked = true
        pending.resolve(listed('late'))
        fallback.resolve()
        await ready
        await vi.advanceTimersByTimeAsync(0)
        expect(asked).toHaveLength(before)
        expect(catalog.read(chat)).toBeUndefined()
        await vi.advanceTimersByTimeAsync(10_000)
        expect(await catalog.settled(chat, 1_000)).toBeDefined()
        expect(asked).toHaveLength(before + 1)
      }
      expect(warned).toHaveBeenCalledTimes(10)
    } finally {
      fallback.resolve()
      codex.dispose()
      claude.dispose()
      warned.mockRestore()
      vi.useRealTimers()
    }
  })
})

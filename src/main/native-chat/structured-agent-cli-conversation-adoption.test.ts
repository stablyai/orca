import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adoptsCliConversations,
  CLI_CONVERSATION_ADOPTING_AGENTS
} from '../../shared/structured-agent-cli-conversation-adoption'
import {
  clearGrokSessionPathLookupCacheForTests,
  findGrokChatHistoryBySessionId,
  grokEncodedCwdDirName,
  GROK_SESSION_GROUP_SCAN_MAX_ENTRIES,
  setGrokSessionDirectoryOpenerForTests
} from '../../shared/grok-session-paths'
import {
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
  structuredAgentRuntimeRegistration
} from '../runtime/structured-agent-runtime-registrations'
import { resolveStructuredAgentSessionAdoptionForCreate } from '../runtime/structured-agent-session-create-adoption'
import { prepareLegacyTranscriptImport } from './agent-session-journal/journal-legacy-import'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { writeOpenCodeSqliteDatabase } from '../ai-vault/session-scanner-opencode-sqlite-fixture'
import { resolveAcpLaunchInvocation } from '../acp/acp-structured-launch-resolution'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { resolveOpenCodeDatabasePath } from '../opencode/opencode-data-directory'
import * as hostReadableTranscriptPath from './host-readable-transcript-path'

// The OpenCode reader's worker, run in process.
vi.mock('../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async (importOriginal) => {
  const query = await import('./transcript-opencode-sqlite-query')
  return {
    ...(await importOriginal<object>()),
    readOpenCodeTranscriptPageViaWorker: async (
      args: Parameters<typeof query.readOpenCodeTranscriptPage>[0]
    ) => query.readOpenCodeTranscriptPage(args),
    readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
      query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
  }
})

const SESSION_ID = '0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a'
let root: string | null = null

async function createAdoptionTestDirectory(prefix: string): Promise<string> {
  return realpath(await mkdtemp(prefix))
}

beforeEach(() => {
  // Grok and Pi also look where Session History lists them from; keep that off the real home.
  vi.stubEnv('GROK_HOME', join(tmpdir(), 'orca-adopt-no-grok-home'))
  vi.stubEnv('PI_CODING_AGENT_DIR', join(tmpdir(), 'orca-adopt-no-pi-home'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  clearGrokSessionPathLookupCacheForTests()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = null
})

/** Each agent's CLI conversation as its own CLI lays it out under an account home. */
const RECORDED: Record<'grok' | 'omp' | 'pi', (home: string, text: string) => Promise<string>> = {
  grok: async (home, text) => {
    const dir = join(home, 'sessions', encodeURIComponent('/repo/orca'), SESSION_ID)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'chat_history.jsonl')
    await writeFile(
      file,
      `${JSON.stringify({ type: 'user', content: [{ type: 'text', text }], timestamp: '2026-10-12T00:00:00.000Z' })}\n`
    )
    return file
  },
  omp: async (home, text) => {
    const dir = join(home, 'sessions', '--repo-orca--')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `2026-10-12T00-00-00-000Z_${SESSION_ID}.jsonl`)
    await writeFile(
      file,
      [
        {
          type: 'session',
          id: SESSION_ID,
          cwd: '/repo/orca',
          timestamp: '2026-10-12T00:00:00.000Z'
        },
        {
          type: 'message',
          id: 'rec-1',
          parentId: null,
          timestamp: '2026-10-12T00:00:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text }] }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')
    )
    return file
  },
  // Pi's documented format: a system message carries the prompt in `sections`, its content empty.
  pi: async (home, text) => {
    const dir = join(home, 'sessions', '--repo-orca--')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `2026-10-12T00-00-00-000Z_${SESSION_ID}.jsonl`)
    const records = [
      { type: 'session', version: 3, id: SESSION_ID, cwd: '/repo/orca' },
      {
        type: 'message',
        id: 'a0b1c2d3',
        parentId: null,
        message: { role: 'system', content: '', sections: { preamble: 'You are Pi' } }
      },
      {
        type: 'message',
        id: 'a1b2c3d4',
        parentId: 'a0b1c2d3',
        message: { role: 'user', content: text, timestamp: 1_791_763_201_000 }
      },
      {
        type: 'message',
        id: 'b2c3d4e5',
        parentId: 'a1b2c3d4',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }], stopReason: 'stop' }
      }
    ]
    await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    return file
  }
}

const ACCOUNT_VARIABLE = {
  grok: 'GROK_HOME',
  omp: 'PI_CODING_AGENT_DIR',
  pi: 'PI_CODING_AGENT_DIR'
}

function adopt(
  agent: 'grok' | 'omp' | 'opencode' | 'pi',
  selectedAccountHome: AgentSessionAccountHome,
  providerSessionId = SESSION_ID,
  launchEnv: NodeJS.ProcessEnv = process.env,
  workspaceCwd = '/repo/orca'
) {
  const transcriptImport = structuredAgentRuntimeRegistration(agent)?.transcriptImport
  if (!transcriptImport) {
    throw new Error(`${agent} registers no transcript import`)
  }
  return resolveStructuredAgentSessionAdoptionForCreate({
    settings: {},
    agent,
    transcriptImport,
    providerSessionId,
    selectedAccountHome,
    launchEnv,
    workspaceCwd
  })
}

describe('which chats can take over a CLI conversation', () => {
  it('names, for every row an importing chat lists, only chats that import and list it', () => {
    const importing = STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.filter(
      (registration) => registration.transcriptImport
    )
    const rows = new Set(importing.flatMap((registration) => registration.sessionHistory.rowAgents))
    expect(new Set(Object.keys(CLI_CONVERSATION_ADOPTING_AGENTS))).toEqual(rows)
    for (const [row, agents] of Object.entries(CLI_CONVERSATION_ADOPTING_AGENTS)) {
      for (const agent of agents) {
        const registration = importing.find((entry) => entry.definition.agent === agent)
        expect(registration?.sessionHistory.rowAgents, `${agent} takes over ${row}`).toContain(row)
      }
    }
    // Each importing chat takes over the rows of its own name first.
    for (const registration of importing) {
      const { agent } = registration.definition
      if (adoptsCliConversations(agent)) {
        expect(CLI_CONVERSATION_ADOPTING_AGENTS[agent][0]).toBe(agent)
      }
    }
  })
})

it.each([false, true])(
  'finds a Grok cwd beyond the generic cap (long path: %s)',
  async (longPath) => {
    root = await createAdoptionTestDirectory(join(tmpdir(), 'orca-grok-adopt-cwd-'))
    const workspaceCwd = join(root, longPath ? '中'.repeat(80) : 'workspace')
    const recorded = await RECORDED.grok(root, 'CURRENT-WORKSPACE')
    const group = grokEncodedCwdDirName(workspaceCwd)
    if (!group) {
      throw new Error('Expected a CLI cwd group')
    }
    const cwdRecorded = join(root, 'sessions', group, SESSION_ID)
    await mkdir(cwdRecorded, { recursive: true })
    const currentFile = join(cwdRecorded, 'chat_history.jsonl')
    await writeFile(currentFile, await readFile(recorded))
    setGrokSessionDirectoryOpenerForTests(async () => ({
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index <= GROK_SESSION_GROUP_SCAN_MAX_ENTRIES; index += 1) {
          yield {
            name: `earlier-${index}`,
            isDirectory: () => true,
            isSymbolicLink: () => false
          }
        }
      },
      close: async () => {}
    }))

    expect(await findGrokChatHistoryBySessionId(join(root, 'sessions'), SESSION_ID)).toBeNull()
    expect(
      (
        await adopt(
          'grok',
          { variable: 'GROK_HOME', path: root },
          SESSION_ID,
          process.env,
          workspaceCwd
        )
      ).transcriptPath
    ).toBe(currentFile)
  }
)

it('looks up OMP history under the configured launch XDG and profile root', async () => {
  root = await createAdoptionTestDirectory(join(tmpdir(), 'orca-omp-adopt-env-'))
  const ambientData = join(root, 'ambient-data')
  const launchData = join(root, 'launch-data')
  const profile = 'work'
  const ambientSessions = join(ambientData, 'omp', 'profiles', profile, 'sessions')
  const launchSessions = join(launchData, 'omp', 'profiles', profile, 'sessions')
  await mkdir(join(ambientData, 'omp', 'profiles', profile), { recursive: true })
  await mkdir(join(launchData, 'omp', 'profiles', profile), { recursive: true })
  const ambientFile = await RECORDED.omp(join(ambientData, 'omp', 'profiles', profile), 'AMBIENT')
  const launchFile = await RECORDED.omp(join(launchData, 'omp', 'profiles', profile), 'LAUNCH')
  vi.stubEnv('XDG_DATA_HOME', ambientData)
  vi.stubEnv('OMP_PROFILE', profile)
  const launchEnv = {
    ...process.env,
    HOME: root,
    XDG_DATA_HOME: launchData,
    OMP_PROFILE: profile,
    OMP_CODING_AGENT_DIR: ''
  }
  const accountHome = join(root, '.omp', 'agent')

  expect(ambientFile.startsWith(ambientSessions)).toBe(true)
  expect(launchFile.startsWith(launchSessions)).toBe(true)
  expect(
    (
      await adopt(
        'omp',
        { variable: 'PI_CODING_AGENT_DIR', path: accountHome },
        SESSION_ID,
        launchEnv
      )
    ).transcriptPath
  ).toBe(launchFile)
})

it('uses the configured OMP profile when the ambient profile names another session', async () => {
  root = await createAdoptionTestDirectory(join(tmpdir(), 'orca-omp-adopt-profile-'))
  const xdgData = join(root, 'data')
  const ambientProfile = 'ambient'
  const launchProfile = 'configured'
  const ambientHome = join(xdgData, 'omp', 'profiles', ambientProfile)
  const launchHome = join(xdgData, 'omp', 'profiles', launchProfile)
  await mkdir(ambientHome, { recursive: true })
  await mkdir(launchHome, { recursive: true })
  await RECORDED.omp(ambientHome, 'AMBIENT-PROFILE')
  const launchFile = await RECORDED.omp(launchHome, 'LAUNCH-PROFILE')
  vi.stubEnv('XDG_DATA_HOME', xdgData)
  vi.stubEnv('OMP_PROFILE', ambientProfile)

  const accountHome = join(root, '.omp', 'agent')
  const launchEnv = {
    ...process.env,
    HOME: root,
    OMP_PROFILE: launchProfile,
    OMP_CODING_AGENT_DIR: ''
  }
  expect(
    (
      await adopt(
        'omp',
        { variable: 'PI_CODING_AGENT_DIR', path: accountHome },
        SESSION_ID,
        launchEnv
      )
    ).transcriptPath
  ).toBe(launchFile)
})

it.each(['win32', 'linux', 'darwin'] as const)(
  'follows the child home precedence for a named OMP profile on %s',
  async (platform) => {
    root = await createAdoptionTestDirectory(join(tmpdir(), 'orca-omp-adopt-home-'))
    const home = join(root, 'home')
    const userProfile = join(root, 'user-profile')
    const profile = 'work'
    const homeFile = await RECORDED.omp(join(home, '.omp', 'profiles', profile, 'agent'), 'HOME')
    const userProfileFile = await RECORDED.omp(
      join(userProfile, '.omp', 'profiles', profile, 'agent'),
      'USERPROFILE'
    )
    const nativePlatform = process.platform
    const needsWslResolution = hostReadableTranscriptPath.needsWslHostResolution
    // Simulated home precedence still reads fixture paths native to the actual host.
    vi.spyOn(hostReadableTranscriptPath, 'needsWslHostResolution').mockImplementation((path) =>
      needsWslResolution(path, nativePlatform)
    )
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)

    const adoption = await adopt(
      'omp',
      { variable: 'PI_CODING_AGENT_DIR', path: join(root, 'account') },
      SESSION_ID,
      {
        HOME: home,
        USERPROFILE: userProfile,
        OMP_PROFILE: profile
      }
    )

    expect(adoption.transcriptPath).toBe(platform === 'win32' ? userProfileFile : homeFile)
  }
)

it('refuses OMP history from another workspace without creating a blank chat', async () => {
  root = await createAdoptionTestDirectory(join(tmpdir(), 'orca-omp-adopt-other-cwd-'))
  await RECORDED.omp(root, 'OTHER-WORKSPACE')
  await expect(
    adopt(
      'omp',
      { variable: 'PI_CODING_AGENT_DIR', path: root },
      SESSION_ID,
      process.env,
      '/another/workspace'
    )
  ).rejects.toMatchObject({
    refusal: { code: 'agent_session_identity_required' }
  })
})

describe.each(['grok', 'omp', 'pi'] as const)('adopting a %s CLI conversation', (agent) => {
  it('finds the conversation under the chat account and imports its history', async () => {
    root = await createAdoptionTestDirectory(join(tmpdir(), `orca-${agent}-adopt-`))
    const recorded = await RECORDED[agent](root, `ORCA-${agent}-ADOPT`)
    if (agent === 'pi') {
      vi.stubEnv('PI_CODING_AGENT_DIR', root)
    }

    const accountHome = { variable: ACCOUNT_VARIABLE[agent], path: root }
    const adoption = await adopt(agent, accountHome)

    expect(adoption).toEqual({ accountHome, transcriptPath: recorded })
    const imported = await prepareLegacyTranscriptImport({
      agent,
      sessionId: SESSION_ID,
      options: { filePath: adoption.transcriptPath }
    })
    expect(imported.ok && JSON.stringify(imported.items)).toContain(`ORCA-${agent}-ADOPT`)
    if (agent === 'pi' && imported.ok) {
      expect(imported.items.map((item) => item.body.kind === 'message' && item.body.role)).toEqual([
        'user',
        'assistant'
      ])
    }
  })

  it('refuses a conversation the account does not hold, rather than opening a blank chat', async () => {
    root = await createAdoptionTestDirectory(join(tmpdir(), `orca-${agent}-adopt-missing-`))
    await expect(
      adopt(agent, { variable: ACCOUNT_VARIABLE[agent], path: root })
    ).rejects.toMatchObject({
      refusal: { code: 'agent_session_identity_required' }
    })
  })
})

describe('adopting a Pi CLI conversation', () => {
  it('pins the Session History account when another Pi home has the same id', async () => {
    root = await createAdoptionTestDirectory(join(tmpdir(), 'orca-pi-adopt-homes-'))
    const selected = join(root, 'selected')
    const history = join(root, 'history')
    await RECORDED.pi(selected, 'SELECTED')
    const source = await RECORDED.pi(history, 'HISTORY')
    vi.stubEnv('PI_CODING_AGENT_DIR', history)

    expect(await adopt('pi', { variable: 'PI_CODING_AGENT_DIR', path: selected })).toEqual({
      accountHome: { variable: 'PI_CODING_AGENT_DIR', path: history },
      transcriptPath: source
    })
  })
})

describe('adopting an OpenCode CLI conversation', () => {
  const OPENCODE_SESSION = 'ses_orca_adopt'
  const unmanaged: AgentSessionAccountHome = { kind: 'opencode', locator: { kind: 'unmanaged' } }

  function openCodeData(home: string): string {
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('XDG_DATA_HOME', join(home, 'data'))
    vi.stubEnv('OPENCODE_DB', '')
    return join(home, 'data', 'opencode', 'opencode.db')
  }

  it('imports from the configured database the resumed OpenCode child opens', async () => {
    root = await createAdoptionTestDirectory(join(tmpdir(), 'orca-opencode-configured-adopt-'))
    const defaultDb = openCodeData(root)
    const configuredDb = join(root, 'data', 'opencode', 'work.db')
    writeOpenCodeSqliteDatabase(defaultDb, [
      { id: OPENCODE_SESSION, turns: [{ role: 'user', parts: ['wrong database'] }] }
    ])
    writeOpenCodeSqliteDatabase(configuredDb, [
      { id: OPENCODE_SESSION, turns: [{ role: 'user', parts: ['configured database'] }] }
    ])
    const baseEnvironment = { HOME: root, XDG_DATA_HOME: join(root, 'data') }
    const launchEnv = { OPENCODE_DB: 'work.db' }
    const adoption = await adopt('opencode', unmanaged, OPENCODE_SESSION, {
      ...baseEnvironment,
      ...launchEnv
    })
    const spec = acpLaunchSpecFor('opencode')
    if (!spec) {
      throw new Error('OpenCode launch spec missing')
    }
    const launch = await resolveAcpLaunchInvocation(spec, unmanaged, {
      resolveEnvironment: async () => baseEnvironment,
      resolveLaunchEnv: () => launchEnv,
      resolveCommand: () => '/test/opencode',
      dataDirectory: root
    })

    expect(adoption.transcriptPath).toBe(configuredDb)
    expect(resolveOpenCodeDatabasePath(launch.env, launch.env.HOME)).toBe(configuredDb)
    const imported = await prepareLegacyTranscriptImport({
      agent: 'opencode',
      sessionId: OPENCODE_SESSION,
      options: { filePath: adoption.transcriptPath }
    })
    expect(imported.ok && JSON.stringify(imported.items)).toContain('configured database')
    expect(imported.ok && JSON.stringify(imported.items)).not.toContain('wrong database')
  })
})

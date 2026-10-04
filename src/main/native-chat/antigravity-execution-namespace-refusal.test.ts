import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { RuntimeMobileSessionTerminalClientTab } from '../../shared/runtime-types'
import {
  configureNativeChatExecutionNamespace,
  antigravitySessionWslDistro
} from './native-chat-execution-namespace'
import { resolveSessionFilePath } from './session-file-resolver'
import { readNativeChatTranscript } from './transcript-reader'
import { readNativeChatTranscriptTail } from './transcript-tail-reader'
import { nativeChatTranscriptIncludesPath } from './native-chat-file-provenance'
import * as transcriptFs from './wsl-transcript-fs-access'

const ID = 'repair-native-remote-collision'
let fixtureHome: string
let sentinel: string
let citedPath: string
let rows: AgentStatusIpcPayload[] = []

function owner(connectionId: string | null): AgentStatusIpcPayload {
  return {
    paneKey: 'tab:leaf',
    agentType: 'antigravity',
    state: 'working',
    prompt: '',
    receivedAt: 1,
    stateStartedAt: 1,
    connectionId,
    providerSession: { key: 'conversation_id', id: ID }
  }
}

beforeEach(async () => {
  rows = []
  configureNativeChatExecutionNamespace(() => rows)
  fixtureHome = await mkdtemp(join(tmpdir(), 'namespace-sentinel-'))
  vi.stubEnv('HOME', fixtureHome)
  vi.stubEnv('USERPROFILE', fixtureHome)
  const logs = join(
    fixtureHome,
    '.gemini',
    'antigravity-cli',
    'brain',
    ID,
    '.system_generated',
    'logs'
  )
  sentinel = join(logs, 'transcript.jsonl')
  citedPath = join(fixtureHome, 'local-only-evidence.txt')
  await mkdir(logs, { recursive: true })
  await writeFile(
    sentinel,
    `${JSON.stringify({
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: `Open ${citedPath}`
    })}\n`
  )
  vi.spyOn(transcriptFs, 'wslGatedOpen')
  vi.spyOn(transcriptFs, 'openTranscriptReadStream')
})
afterEach(async () => {
  configureNativeChatExecutionNamespace(() => [])
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(fixtureHome, { recursive: true, force: true })
})

it.each([
  'ssh-only',
  'runtime:paired-only',
  'runtime-paired-only',
  'runtime-ssh-paired-host',
  'unknown-host',
  ' '
])('refuses %s before opening the same-named native transcript', async (connectionId) => {
  rows = [owner(connectionId)]
  await expect(resolveSessionFilePath('antigravity', ID)).rejects.toThrow(/namespace.*unavailable/)
  await expect(readNativeChatTranscript('antigravity', ID)).rejects.toThrow(
    /namespace.*unavailable/
  )
  await expect(
    readNativeChatTranscriptTail({ agent: 'antigravity', sessionId: ID, limit: 10 })
  ).rejects.toThrow(/namespace.*unavailable/)
  expect(transcriptFs.wslGatedOpen).not.toHaveBeenCalled()
  expect(transcriptFs.openTranscriptReadStream).not.toHaveBeenCalled()
})

it.each([null, 'wsl:Ubuntu'])(
  'refuses remote ownership even beside a same-ID %s owner',
  async (connectionId) => {
    rows = [owner(connectionId), owner('ssh-unverifiable')]
    await expect(resolveSessionFilePath('antigravity', ID)).rejects.toThrow(
      /namespace.*unavailable/
    )
    expect(transcriptFs.wslGatedOpen).not.toHaveBeenCalled()
  }
)

it.each([
  [null, 'wsl:Ubuntu'],
  ['wsl:Ubuntu', 'wsl:Debian']
] as const)(
  'rejects ambiguous native/guest or different-guest owners (%s, %s)',
  async (left, right) => {
    rows = [owner(left), owner(right)]
    await expect(resolveSessionFilePath('antigravity', ID)).rejects.toThrow(/namespace.*ambiguous/)
  }
)

it('deduplicates the same WSL distro and refuses a mismatched requested distro', async () => {
  rows = [owner('wsl:Ubuntu'), owner('wsl:Ubuntu')]
  expect(antigravitySessionWslDistro(ID)).toBe('Ubuntu')
  await expect(resolveSessionFilePath('antigravity', ID, { wslDistro: 'Debian' })).rejects.toThrow(
    /namespace.*match/
  )
})

it.each(['historical', 'native'])('preserves %s transcripts', async (kind) => {
  rows = kind === 'native' ? [owner(null)] : []
  expect(await resolveSessionFilePath('antigravity', ID)).toBe(sentinel)
  const full = await readNativeChatTranscript('antigravity', ID)
  expect(full).toMatchObject({
    messages: [{ blocks: [{ type: 'text', text: `Open ${citedPath}` }] }]
  })
  const tail = await readNativeChatTranscriptTail({
    agent: 'antigravity',
    sessionId: ID,
    limit: 10
  })
  expect(tail).toHaveProperty('messages')
  expect(transcriptFs.wslGatedOpen).toHaveBeenCalled()
})

function clientTab(connectionId: string | null | undefined): RuntimeMobileSessionTerminalClientTab {
  return {
    type: 'terminal',
    id: 'tab',
    title: 'Antigravity',
    parentTabId: 'tab',
    leafId: 'leaf',
    launchAgent: 'antigravity',
    isActive: true,
    status: 'ready',
    terminal: 'term',
    agentStatus: {
      paneKey: 'tab:leaf',
      agentType: 'antigravity',
      state: 'working',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: [],
      connectionId,
      providerSession: { key: 'conversation_id', id: ID }
    }
  }
}

it.each([
  ['ssh-unverifiable', true],
  ['runtime-ssh-paired-host', true],
  ['ssh-unverifiable', false],
  ['runtime-ssh-paired-host', false],
  ['unknown-host', false],
  ['wsl:Ubuntu', false],
  ['wsl:', false]
] as const)(
  'the ungated provenance path refuses the native collision for %s (canonical owner present: %s)',
  async (connectionId, ownerPresent) => {
    rows = ownerPresent ? [owner(connectionId)] : []
    expect(
      await nativeChatTranscriptIncludesPath({
        tabs: [clientTab(connectionId)],
        context: { tabId: 'tab', sessionId: ID },
        pathText: citedPath,
        absolutePath: citedPath
      })
    ).toBe(false)
    expect(transcriptFs.wslGatedOpen).not.toHaveBeenCalled()
  }
)

it.each([null, undefined])(
  'preserves native and historical provenance (%s connection)',
  async (connectionId) => {
    expect(
      await nativeChatTranscriptIncludesPath({
        tabs: [clientTab(connectionId)],
        context: { tabId: 'tab', sessionId: ID },
        pathText: citedPath,
        absolutePath: citedPath
      })
    ).toBe(true)
    expect(transcriptFs.wslGatedOpen).toHaveBeenCalled()
  }
)

it.each([null, 'wsl:Debian'])(
  'refuses a WSL tab constraint that disagrees with its %s canonical owner',
  async (connectionId) => {
    rows = [owner(connectionId)]
    expect(() => antigravitySessionWslDistro(ID, 'wsl:Ubuntu')).toThrow('ambiguous')
    expect(
      await nativeChatTranscriptIncludesPath({
        tabs: [clientTab('wsl:Ubuntu')],
        context: { tabId: 'tab', sessionId: ID },
        pathText: citedPath,
        absolutePath: citedPath
      })
    ).toBe(false)
    expect(transcriptFs.wslGatedOpen).not.toHaveBeenCalled()
  }
)

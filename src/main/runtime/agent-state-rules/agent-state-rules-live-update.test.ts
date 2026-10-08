import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTerminalTailSentinelMatches } from '../terminal-tail-sentinel-index'
import {
  activateAgentStateRules,
  BUNDLED_AGENT_STATE_RULES,
  getActiveAgentStateRules
} from './active-agent-state-rules'
import { BUNDLED_AGENT_STATE_RULES_VERSION } from './agent-state-rules-bundle'
import { BUNDLED_AGENT_STATE_RULE_FILES } from './agent-state-rules-catalog'
import { idleTitleRequiresQuiet } from './agent-state-rules-engine'
import {
  AgentStateRulesLiveUpdater,
  agentStateRulesCacheFileName,
  agentStateRulesChannelForAppVersion,
  agentStateRulesDownloadUrl,
  type AgentStateRulesLiveUpdateDeps
} from './agent-state-rules-live-update'
import { detectExplicitIdleStatusFromTitle } from '../terminal-wait-detection'
import { showsIdleTitleAnchor } from './agent-state-title-anchors'

const NEWER = 9999
const NEWEST = 10000

function bundledFile(id: string): Record<string, unknown> {
  const file = BUNDLED_AGENT_STATE_RULE_FILES.find((candidate) => candidate.id === id)
  if (!file) {
    throw new Error(`no bundled ${id}`)
  }
  return structuredClone(file)
}

// A Claude file whose title rule settles without quiet: visible through idleTitleRequiresQuiet.
function claudeWithoutQuiet(): Record<string, unknown> {
  const claude = bundledFile('claude')
  return {
    ...claude,
    rules: [
      {
        id: 'idle_title',
        why: 'test',
        priority: 100,
        when: { region: 'title', status: 'idle' },
        answer: { state: 'idle', strength: 'weak', requiresQuiet: false }
      }
    ]
  }
}

function bundleText(
  version: number,
  files: unknown[] = [claudeWithoutQuiet()],
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({ version, engineVersion: 1, ...extra, files })
}

type Harness = {
  updater: AgentStateRulesLiveUpdater
  userData: string
  settings: { agentStateRulesPath?: string | null; agentStateRulesLiveUpdates?: boolean }
  fetch: ReturnType<typeof vi.fn>
  onActivated: ReturnType<typeof vi.fn>
}

let userData: string
let warn: ReturnType<typeof vi.spyOn>

function status(): { version: number; source: string } {
  const { version, source } = getActiveAgentStateRules()
  return { version, source }
}

function warnings(): string[] {
  return warn.mock.calls.map(([message]) => String(message))
}

function harness(overrides: Partial<AgentStateRulesLiveUpdateDeps> = {}): Harness {
  const settings: Harness['settings'] = {}
  const fetch = vi.fn(async () => new Response('Not Found', { status: 404 }))
  const onActivated = vi.fn()
  const updater = new AgentStateRulesLiveUpdater({
    userDataPath: userData,
    appVersion: '1.4.0',
    isPackaged: true,
    fetch,
    readSettings: () => settings,
    onActivated,
    ...overrides
  })
  return { updater, userData, settings, fetch, onActivated }
}

function serve(h: Harness, text: string): void {
  h.fetch.mockImplementation(async () => new Response(text, { status: 200 }))
}

function cachePath(channel: 'next' | 'stable' = 'stable'): string {
  return join(userData, agentStateRulesCacheFileName(channel))
}

function writeCache(text: string, channel: 'next' | 'stable' = 'stable'): void {
  writeFileSync(cachePath(channel), text)
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'agent-state-rules-live-update-'))
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  activateAgentStateRules(BUNDLED_AGENT_STATE_RULES)
  warn.mockRestore()
  rmSync(userData, { recursive: true, force: true })
})

describe('agent state rules channel and URL', () => {
  it.each([
    ['1.4.0', 'stable'],
    ['1.4.1-rc.2', 'next'],
    ['1.4.1-rc.2.perf', 'next'],
    ['not-a-version', null]
  ])('maps app version %s to %s', (version, channel) => {
    expect(agentStateRulesChannelForAppVersion(version)).toBe(channel)
  })

  it('fetches the fixed release-download URL for the engine and channel', () => {
    expect(agentStateRulesDownloadUrl('next')).toBe(
      'https://github.com/stablyai/orca/releases/download/agent-state-rules-engine-1-next/agent-state-rules.json'
    )
  })
})

describe('agent state rules live updates', () => {
  it('starts on the bundled rules and fetches the stable tag for a stable app', async () => {
    const h = harness()
    await h.updater.start()
    expect(h.fetch).toHaveBeenCalledWith(agentStateRulesDownloadUrl('stable'), expect.anything())
    expect(status()).toEqual({ version: BUNDLED_AGENT_STATE_RULES_VERSION, source: 'bundled' })
    expect(warnings()).toEqual(['[agent-state-rules] download failed: HTTP 404'])
    h.updater.stop()
  })

  it('accepts a newer download, writes it atomically, and hot-reloads the engine', async () => {
    const h = harness({ appVersion: '1.4.1-rc.0' })
    expect(idleTitleRequiresQuiet('claude')).toBe(true)
    const text = bundleText(NEWER)
    serve(h, text)
    await h.updater.start()
    expect(h.fetch).toHaveBeenCalledWith(agentStateRulesDownloadUrl('next'), expect.anything())
    expect(status()).toEqual({ version: NEWER, source: 'downloaded' })
    expect(warnings()).toEqual([])
    expect(idleTitleRequiresQuiet('claude')).toBe(false)
    expect(readFileSync(cachePath('next'), 'utf8')).toBe(text)
    expect(readdirSync(userData)).toEqual([agentStateRulesCacheFileName('next')])
    expect(h.onActivated).toHaveBeenCalledWith({ version: NEWER, source: 'downloaded' })
    h.updater.stop()
  })

  it('keeps every agent the download does not carry on its bundled file', async () => {
    const h = harness()
    serve(h, bundleText(NEWER))
    await h.updater.start()
    const active = getActiveAgentStateRules()
    expect(active.files.map((file) => file.id)).toEqual(
      BUNDLED_AGENT_STATE_RULE_FILES.map((file) => file.id)
    )
    expect(active.files.find((file) => file.id === 'gemini')).toBe(
      BUNDLED_AGENT_STATE_RULE_FILES.find((file) => file.id === 'gemini')
    )
    h.updater.stop()
  })

  it.each([
    ['not newer than the bundled copy', bundleText(BUNDLED_AGENT_STATE_RULES_VERSION), null],
    [
      'built for another engine',
      JSON.stringify({ version: NEWER, engineVersion: 2, files: [] }),
      'download rejected: '
    ],
    [
      'carrying an agent with no transcript suite',
      bundleText(NEWER, [bundledFile('gemini')]),
      'download rejected: carries gemini, which has no transcript suite to gate it'
    ],
    [
      'an unsafe pattern',
      bundleText(NEWER, [
        {
          ...bundledFile('claude'),
          anchors: [
            {
              id: 'bad',
              why: 'test',
              when: { region: 'title', status: 'idle', match: { regex: '(a+)+$' } },
              answer: { state: 'idle' }
            }
          ]
        }
      ]),
      'repeats a group'
    ],
    ['not JSON', '{', 'download rejected: '],
    [
      'over the size cap',
      ' '.repeat(256 * 1024 + 1),
      'download failed: Response body exceeds 262144 byte limit'
    ]
  ])('refuses a download %s and keeps the bundled rules', async (_label, text, error) => {
    const h = harness()
    serve(h, text)
    await h.updater.start()
    expect(status()).toEqual({ version: BUNDLED_AGENT_STATE_RULES_VERSION, source: 'bundled' })
    if (error === null) {
      expect(warnings()).toEqual([])
    } else {
      expect(warnings()).toEqual([expect.stringContaining(error)])
    }
    expect(readdirSync(userData)).toEqual([])
    h.updater.stop()
  })

  it('keeps the last good copy through a 404, a network error and an older download', async () => {
    const h = harness()
    serve(h, bundleText(NEWEST))
    await h.updater.start()
    h.fetch.mockImplementation(async () => new Response('Not Found', { status: 404 }))
    await h.updater.refresh()
    expect(status()).toMatchObject({ version: NEWEST, source: 'downloaded' })
    h.fetch.mockImplementation(async () => {
      throw new Error('offline')
    })
    await h.updater.refresh()
    expect(status()).toEqual({ version: NEWEST, source: 'downloaded' })
    expect(warnings().at(-1)).toBe('[agent-state-rules] download failed: offline')
    serve(h, bundleText(NEWER))
    await h.updater.refresh()
    expect(status()).toEqual({ version: NEWEST, source: 'downloaded' })
    expect(JSON.parse(readFileSync(cachePath(), 'utf8'))).toMatchObject({ version: NEWEST })
    h.updater.stop()
  })

  it('activates a cached download newer than the bundled rules before any fetch lands', async () => {
    writeCache(bundleText(NEWER))
    const h = harness()
    h.fetch.mockImplementation(() => new Promise<Response>(() => {}))
    void h.updater.start()
    await vi.waitFor(() => expect(status().source).toBe('downloaded'))
    expect(status().version).toBe(NEWER)
    h.updater.stop()
  })

  it('ignores a cached download that is not newer than the bundled rules', async () => {
    writeCache(bundleText(BUNDLED_AGENT_STATE_RULES_VERSION))
    const h = harness()
    await h.updater.start()
    expect(status().source).toBe('bundled')
    h.updater.stop()
  })

  it("never reads the other channel's cache", async () => {
    // Why: an RC build left next rules in the userData a stable build now shares.
    writeCache(bundleText(NEWEST), 'next')
    const h = harness()
    serve(h, bundleText(NEWER))
    await h.updater.start()
    expect(status()).toMatchObject({ version: NEWER, source: 'downloaded' })
    expect(JSON.parse(readFileSync(cachePath('next'), 'utf8'))).toMatchObject({ version: NEWEST })
    h.updater.stop()
  })

  it('lets no superseded start or fetch change the rules after a restart', async () => {
    const overridePath = join(userData, 'override.json')
    writeFileSync(overridePath, bundleText(1, [bundledFile('gemini')]))
    const h = harness()
    let land: (response: Response) => void = () => {}
    h.fetch.mockImplementation(() => new Promise<Response>((resolve) => (land = resolve)))
    h.settings.agentStateRulesPath = overridePath
    const superseded = h.updater.start()
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1))
    h.settings.agentStateRulesPath = null
    h.settings.agentStateRulesLiveUpdates = false
    await h.updater.start()
    land(new Response(bundleText(NEWER), { status: 200 }))
    await superseded
    expect(status()).toEqual({ version: BUNDLED_AGENT_STATE_RULES_VERSION, source: 'bundled' })
    expect(readdirSync(userData)).toEqual(['override.json'])
  })

  it('refuses a download no newer than the cached one', async () => {
    writeCache(bundleText(NEWEST))
    const h = harness()
    serve(h, bundleText(NEWER, [bundledFile('claude')]))
    await h.updater.start()
    expect(status()).toMatchObject({ version: NEWEST, source: 'downloaded' })
    expect(idleTitleRequiresQuiet('claude')).toBe(false)
    h.updater.stop()
  })

  it('falls back to the bundled rules when a published bundle says bundledOnly', async () => {
    const h = harness()
    serve(h, bundleText(NEWER))
    await h.updater.start()
    serve(h, bundleText(NEWEST, [claudeWithoutQuiet()], { bundledOnly: true }))
    await h.updater.refresh()
    expect(status()).toMatchObject({ source: 'bundled' })
    expect(idleTitleRequiresQuiet('claude')).toBe(true)
    h.updater.stop()
  })

  it('uses only the bundled rules when the setting turns live updates off', async () => {
    writeCache(bundleText(NEWER))
    const h = harness()
    h.settings.agentStateRulesLiveUpdates = false
    await h.updater.start()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(status().source).toBe('bundled')
    h.updater.stop()
  })

  it('never fetches from an unpackaged build', async () => {
    const h = harness({ isPackaged: false })
    await h.updater.start()
    expect(h.fetch).not.toHaveBeenCalled()
    h.updater.stop()
  })

  it('ranks a local override over a download over the bundled rules', async () => {
    const overridePath = join(userData, 'override.json')
    // Why gemini: the override may carry an agent a rules release cannot.
    writeFileSync(overridePath, bundleText(1, [bundledFile('gemini')]))
    writeCache(bundleText(NEWER))
    const h = harness()
    h.settings.agentStateRulesPath = overridePath
    await h.updater.start()
    expect(status()).toMatchObject({ version: 1, source: 'override' })

    h.settings.agentStateRulesPath = null
    await h.updater.start()
    expect(status()).toMatchObject({ version: NEWER, source: 'downloaded' })
    h.updater.stop()
  })

  it('reports a rejected override and keeps the next source in line', async () => {
    const overridePath = join(userData, 'override.json')
    writeFileSync(overridePath, '{"version":1,"engineVersion":1,"files":[{"id":"claude"}]}')
    const h = harness()
    h.settings.agentStateRulesPath = overridePath
    await h.updater.start()
    expect(status().source).toBe('bundled')
    expect(warnings()[0]).toContain(`override ${overridePath} rejected`)
    expect(h.onActivated).not.toHaveBeenCalled()
    h.updater.stop()
  })

  it('still activates an accepted download when the cache cannot be written', async () => {
    const h = harness({ userDataPath: join(userData, 'missing', 'dir') })
    serve(h, bundleText(NEWER))
    await h.updater.start()
    expect(status().source).toBe('downloaded')
    expect(warnings()).toEqual([expect.stringContaining('downloaded rules not cached')])
    h.updater.stop()
  })
})

describe('agent state rules hot reload', () => {
  it('recompiles the title anchors every pane reads, past the title memo', () => {
    expect(showsIdleTitleAnchor('✳ Claude Code')).toBe(true)
    expect(detectExplicitIdleStatusFromTitle('✳ Claude Code')).toBe('idle')
    activateAgentStateRules({
      ...BUNDLED_AGENT_STATE_RULES,
      files: BUNDLED_AGENT_STATE_RULES.files.map((file) =>
        file.id === 'claude' ? { ...file, anchors: [] } : file
      )
    })
    expect(showsIdleTitleAnchor('✳ Claude Code')).toBe(false)
    expect(detectExplicitIdleStatusFromTitle('✳ Claude Code')).toBeNull()
  })

  it('rescans a tail the sentinel index already covered when a blocked anchor arrives', () => {
    const lines = ['zebra crossing prompt']
    expect(getTerminalTailSentinelMatches(lines)).toEqual([])
    activateAgentStateRules({
      ...BUNDLED_AGENT_STATE_RULES,
      files: BUNDLED_AGENT_STATE_RULES.files.map((file) =>
        file.id === 'claude'
          ? {
              ...file,
              anchors: [
                ...file.anchors,
                {
                  id: 'zebra',
                  why: 'test',
                  when: { region: 'text', find: { lastOf: 'zebra crossing' } },
                  answer: { state: 'blocked', reason: 'agent-approval-prompt' }
                }
              ]
            }
          : file
      )
    })
    expect(getTerminalTailSentinelMatches(lines)).toEqual([0])
  })
})

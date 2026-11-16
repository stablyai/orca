import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTerminalTailSentinelMatches } from '../terminal/output/tail/terminal-tail-sentinel-index'
import {
  activateAgentStateRules,
  BUNDLED_AGENT_STATE_RULES,
  getActiveAgentStateRules
} from './active-agent-state-rules'
import { BUNDLED_AGENT_STATE_RULES_VERSION } from './agent-state-rules-bundle'
import { BUNDLED_AGENT_STATE_RULE_FILES } from './agent-state-rules-catalog'
import {
  AgentStateRulesLiveUpdater,
  type AgentStateRulesLiveUpdateDeps
} from './agent-state-rules-live-update'
import { detectExplicitIdleStatusFromTitle } from '../terminal/wait/terminal-wait-detection'
import { showsIdleTitleAnchor } from './agent-state-title-anchors'

const NEWER = 9999

function bundledFile(id: string): Record<string, unknown> {
  const file = BUNDLED_AGENT_STATE_RULE_FILES.find((candidate) => candidate.id === id)
  if (!file) {
    throw new Error(`no bundled ${id}`)
  }
  return structuredClone(file)
}

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

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'agent-state-rules-live-update-'))
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  activateAgentStateRules(BUNDLED_AGENT_STATE_RULES)
  warn.mockRestore()
  rmSync(userData, { recursive: true, force: true })
})

describe('agent state rules live updates', () => {
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

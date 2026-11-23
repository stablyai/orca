import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { ClaudeAtRestCommandCatalog } from '../../../claude/command-catalog/claude-at-rest-commands'
import { createClaudeCommandCatalogProbe } from '../../../claude/command-catalog/claude-command-catalog-probe'
import type { ClaudeCliFlagSupport } from '../../../claude/cli-capabilities/claude-cli-flag-support'
import type { ClaudeModelCatalogProbeDeps } from '../../../claude/model-catalog/claude-model-catalog-probe'
import { claudeAtRestDiscovery } from './structured-agent-at-rest-discovery'

let folder: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'claude-at-rest-discovery-'))
})
afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

const record: AgentSessionRecord = {
  ...agentSessionRecordFixture(),
  sessionId: 'resting-bot-chat',
  provider: 'claude',
  accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/homes/claude' },
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'folder:bot-home',
    workspaceKind: 'folder'
  }
}

/** What Claude answers `initialize` with, as it lists commands. */
const INITIALIZE_ANSWER = JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'orca-command-discovery',
    response: { commands: [{ name: 'review', description: 'Review things (project)' }] }
  }
})

async function restingMenu(pluginFlag: 'supported' | 'unsupported') {
  const runs: string[][] = []
  const runListing: ClaudeModelCatalogProbeDeps['runListing'] = async (listing) => {
    runs.push([...listing.args])
    return INITIALIZE_ANSWER
  }
  const catalog = new ClaudeAtRestCommandCatalog({
    resolveWorkspacePath: async () => folder,
    probe: createClaudeCommandCatalogProbe({
      resolveCommand: () => ({ command: '/bin/claude', prefixArgs: [] }),
      resolveEnv: () => ({}),
      resolveInheritedEnv: async () => ({ PATH: '/bin' }),
      resolveAuthPolicy: () => ({ account: 'system' }),
      runListing
    }),
    discovery: claudeAtRestDiscovery({
      stateDirectory: '/state',
      resolveLaunchArgs: () => ['--add-dir', '/mine'],
      nativeChatVisuals: { isEnabled: () => true },
      claudeCliFlags: {
        check: async () => pluginFlag,
        prewarm: () => {},
        observeExit: () => {}
      } satisfies ClaudeCliFlagSupport,
      prepareSessionLinkedSkills: async () => ({
        root: {
          skillsRoot: '/bot-links/skills',
          pluginDir: '/bot-links',
          linksOut: true
        },
        projects: []
      })
    })
  })
  const commands = await catalog.settled(record, 5_000, true)
  catalog.dispose()
  return { commands, args: runs[0] ?? [] }
}

const flagValues = (args: readonly string[], flag: string): string[] =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []))

it("probes a resting chat with its launch's folders and settings, kept apart from the chat", async () => {
  const { commands, args } = await restingMenu('supported')

  expect(flagValues(args, '--add-dir')).toEqual([
    '/mine',
    join('/state', 'agent-session-attachments'),
    '/bot-links'
  ])
  expect(flagValues(args, '--plugin-dir')).toEqual([
    join(process.cwd(), 'resources', 'native-chat-visuals')
  ])
  expect(args).toContain('--setting-sources=user,project,local')
  expect(args).toContain('--strict-mcp-config')
  expect(flagValues(args, '--settings')).toEqual(['{"disableAllHooks":true}'])
  expect(commands).toEqual([
    {
      name: 'review',
      kind: 'command',
      kindUnspecified: true,
      description: 'Review things (project)'
    }
  ])
})

it('loads no visuals plugin from a Claude CLI that takes no plugin folders', async () => {
  const { args } = await restingMenu('unsupported')

  expect(flagValues(args, '--plugin-dir')).toEqual([])
  expect(flagValues(args, '--add-dir')).toContain('/bot-links')
})

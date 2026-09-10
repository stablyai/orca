import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

import { claudeHookService } from '../claude/hook-service'
import { openClaudeHookService } from '../openclaude/hook-service'
import { codexHookService } from '../codex/hook-service'
import { geminiHookService } from '../gemini/hook-service'
import { antigravityHookService } from '../antigravity/hook-service'
import { ampHookService } from '../amp/hook-service'
import { cursorHookService } from '../cursor/hook-service'
import { droidHookService } from '../droid/hook-service'
import { commandCodeHookService } from '../command-code/hook-service'
import { grokHookService } from '../grok/hook-service'
import { copilotHookService } from '../copilot/hook-service'
import { hermesHookService } from '../hermes/hook-service'
import { devinHookService } from '../devin/hook-service'
import { kimiHookService } from '../kimi/hook-service'
import { jcodeHookService } from '../jcode/hook-service'
import { MANAGED_AGENT_HOOK_INSTALLERS } from './managed-agent-hook-controls'
import { REMOTE_MANAGED_HOOK_INSTALLER_AGENTS } from './remote-managed-hook-installers'

// Why: Droid (and Copilot) each shipped a working installRemote but were never
// registered in REMOTE_MANAGED_HOOK_INSTALLERS, so their status silently never
// appeared over SSH (issue #7253). Guard the whole bug class, not one agent:
// every locally-managed hook service that implements installRemote MUST be
// wired into the remote installer.
describe('remote hook installer registry guard', () => {
  it('registers every managed agent that implements installRemote in the remote installer (issue #7253)', () => {
    const servicesByAgent = new Map<string, { installRemote?: unknown }>([
      ['claude', claudeHookService],
      ['openclaude', openClaudeHookService],
      ['codex', codexHookService],
      ['gemini', geminiHookService],
      ['antigravity', antigravityHookService],
      ['amp', ampHookService],
      ['cursor', cursorHookService],
      ['droid', droidHookService],
      ['command-code', commandCodeHookService],
      ['grok', grokHookService],
      ['copilot', copilotHookService],
      ['hermes', hermesHookService],
      ['devin', devinHookService],
      ['kimi', kimiHookService],
      ['jcode', jcodeHookService]
    ])

    // Guard against a service silently missing from the map above as new agents land.
    for (const [agent] of MANAGED_AGENT_HOOK_INSTALLERS) {
      expect(servicesByAgent.has(agent)).toBe(true)
    }

    const registered = new Set<string>(REMOTE_MANAGED_HOOK_INSTALLER_AGENTS)
    const missing: string[] = []
    for (const [agent, service] of servicesByAgent) {
      if (typeof service.installRemote === 'function' && !registered.has(agent)) {
        missing.push(agent)
      }
    }
    expect(missing).toEqual([])
  })
})

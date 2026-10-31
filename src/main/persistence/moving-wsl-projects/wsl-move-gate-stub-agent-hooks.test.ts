import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentHookServer } from '../../agent-hooks/server'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { collectWslMoveGateInputs, type WslMoveGateFactSources } from './wsl-move-gate-facts'
import { assessWslMoveTerminals } from './wsl-move-terminal-gate'

const WT = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const scope = { workspaceIds: [WT], workspaceKeys: new Set([WT]) }

// The verify stub "codex" posts real hook events from the distro. Its
// Stop must let an idle agent pass the gate; only a turn still running may block. (The stub fires
// SessionStart at launch, which reads as a turn start, so a stub never given a prompt blocks.)
describe('the WSL move gate with the stub agent hook events', () => {
  let server: AgentHookServer
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wsl-move-stub-agent-'))
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  async function hook(event: string, prompt = ''): Promise<void> {
    const env = server.buildPtyEnv()
    const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: WT,
        // The stub's payload: no turn ids, a transcript it writes itself.
        payload: {
          session_id: '0f0e0d0c-0b0a-4908-8706-050403020100',
          transcript_path: join(dir, 'rollout-stub.jsonl'),
          cwd: '/home/dev/app',
          hook_event_name: event,
          model: 'stub',
          prompt,
          last_assistant_message: event === 'Stop' ? `stub answer to: ${prompt}` : ''
        }
      })
    })
    expect(response.status).toBe(204)
  }

  async function gate(): Promise<ReturnType<typeof assessWslMoveTerminals>> {
    const sources: WslMoveGateFactSources = {
      listTerminals: () => [
        {
          ptyId: 'pty-1',
          workspaceId: WT,
          paneKey: PANE,
          wslDistro: 'Ubuntu',
          foregroundAgent: null
        }
      ],
      inspect: async () => ({
        foregroundProcess: 'wsl.exe',
        hasChildProcesses: true,
        childProcessEvidence: 'children'
      }),
      agentRows: (paneKey) => server.getStatusSnapshotForPane(paneKey),
      scrollbackBytes: async () => 10,
      automationRuns: () => [],
      dispatches: () => [],
      // The distro sees the stub as the shell's one foreground job.
      guestForegrounds: async () => new Map([[PANE, { agent: 'codex' }]])
    }
    return assessWslMoveTerminals(await collectWslMoveGateInputs(sources, scope))
  }

  it('passes an agent whose turn ended with Stop', async () => {
    await hook('SessionStart')
    await hook('UserPromptSubmit', 'hello p4')
    expect(await gate()).toMatchObject({
      verdict: 'blocked',
      blockers: [{ kind: 'agent-working' }]
    })
    await hook('Stop', 'hello p4')
    expect(await gate()).toEqual({ verdict: 'ready', paneKeys: [PANE] })
  })

  it('passes an agent resumed in its pane until its next prompt starts a turn', async () => {
    await hook('SessionStart')
    await hook('UserPromptSubmit', 'hello p4')
    await hook('Stop', 'hello p4')
    // Resumed after a move or a wake: Codex posts SessionStart only with the first prompt, so an
    // idle resumed agent posts nothing and passes. (The real-host stub posts it at launch instead.)
    expect(await gate()).toEqual({ verdict: 'ready', paneKeys: [PANE] })
    await hook('SessionStart')
    await hook('UserPromptSubmit', 'next')
    expect(await gate()).toMatchObject({ verdict: 'blocked' })
    await hook('Stop', 'next')
    expect(await gate()).toEqual({ verdict: 'ready', paneKeys: [PANE] })
  })
})

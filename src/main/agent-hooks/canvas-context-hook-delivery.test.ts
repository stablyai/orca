import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { AgentHookServer } from './server'
import { buildBody, PANE } from './server.test-fixtures'
import { getManagedScript as codexScript } from '../codex/codex-hook-script'
import { getManagedScript as cursorScript } from '../cursor/hook-script'
import { ClaudeHookService } from '../claude/hook-service'
import { createAgentHookMemorySftp } from './agent-hook-memory-sftp.test-fixture'
import type { CanvasContextBinding } from '../../shared/canvas-agent-context'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '/unused-canvas-test' } }))

const servers: AgentHookServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
})
const token = 'canvas-context-test-launch'
const identity = {
  sessionId: 'canvas-test-session',
  launchTokenHash: createHash('sha256').update(token).digest('hex')
}
const binding: CanvasContextBinding = {
  nodeId: 'agent',
  paneKey: PANE,
  worktreeId: 'wt-1',
  ptyId: 'pty',
  provider: 'claude',
  notes: [{ id: 'note', title: 'Requirements', content: 'Use the canvas note marker: FERN_482.' }]
}
async function createServer(provider: CanvasContextBinding['provider']) {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production' })
  await server.canvasContexts.replace(
    { canvasId: 'canvas', revision: 1, bindings: [{ ...binding, provider }] },
    new Map([['agent', identity]])
  )
  return server
}
async function getClaudeScript(): Promise<string> {
  const memory = createAgentHookMemorySftp()
  await new ClaudeHookService().installRemote(memory.sftp, '/canvas-test-home')
  const script = [...memory.fs.files.entries()].find(([path]) =>
    path.endsWith('/claude-hook.sh')
  )?.[1]
  if (!script) {
    throw new Error('Claude managed hook was not generated')
  }
  return script
}
function hookEnv(server: AgentHookServer): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith('ORCA_') && key !== 'CLAUDE_JOB_DIR' && key !== 'DEVIN_PROJECT_DIR'
      )
    ),
    ...server.buildPtyEnv(),
    ORCA_PANE_KEY: PANE,
    ORCA_TAB_ID: 'tab-1',
    ORCA_WORKTREE_ID: 'wt-1',
    ORCA_AGENT_LAUNCH_TOKEN: token,
    ORCA_AGENT_HOOK_ENDPOINT: ''
  }
}

describe('canvas context HTTP contract', () => {
  it('keeps old hooks on 204 and only returns context to opted-in authenticated hooks', async () => {
    const server = await createServer('claude')
    const env = server.buildPtyEnv()
    const post = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN,
          ...headers
        },
        body: JSON.stringify(
          buildBody(
            {
              hook_event_name: 'UserPromptSubmit',
              session_id: identity.sessionId,
              prompt: 'My request'
            },
            { launchToken: token }
          )
        )
      })
    expect((await post({})).status).toBe(204)
    const response = await post({ 'X-Orca-Canvas-Context': '1' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: expect.stringContaining('FERN_482')
      }
    })
    expect(
      (await post({ 'X-Orca-Canvas-Context': '1', 'X-Orca-Agent-Hook-Token': 'wrong' })).status
    ).toBe(403)
  })
})

describe.skipIf(process.platform === 'win32')('executable managed context hooks', () => {
  it.each(['codex', 'claude', 'cursor'] as const)(
    'emits one native JSON response from the real %s hook script',
    async (provider) => {
      const server = await createServer(provider)
      const script =
        provider === 'codex'
          ? codexScript('posix')
          : provider === 'cursor'
            ? cursorScript('posix')
            : await getClaudeScript()
      const result = await runProcess({
        program: '/bin/sh',
        args: ['-c', script],
        env: hookEnv(server),
        timeoutMs: 5000,
        input: JSON.stringify({
          hook_event_name: provider === 'cursor' ? 'postToolUse' : 'UserPromptSubmit',
          session_id: identity.sessionId,
          conversation_id: identity.sessionId,
          prompt: 'My request',
          tool_name: 'Read',
          tool_input: {}
        })
      })
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.stringify(JSON.parse(result.stdout))).toContain('FERN_482')
      expect(server.getStatusSnapshot()[0].prompt).toBe('My request')
    }
  )

  it('keeps Cursor permission responses fail-open, with no attached context', async () => {
    const server = await createServer('cursor')
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', cursorScript('posix')],
      env: { ...hookEnv(server), ORCA_CURSOR_HOOK_RESPONSE: '{"permission":"allow"}' },
      input: JSON.stringify({
        hook_event_name: 'beforeShellExecution',
        conversation_id: identity.sessionId,
        command: 'echo safe'
      }),
      timeoutMs: 5000
    })
    expect(JSON.parse(result.stdout)).toEqual({ permission: 'allow' })
  })
})

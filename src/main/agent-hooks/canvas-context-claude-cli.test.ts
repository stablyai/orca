import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'
import { ClaudeHookService } from '../claude/hook-service'
import { createAgentHookMemorySftp } from './agent-hook-memory-sftp.test-fixture'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '/unused-canvas-test' } }))

// Opt-in: exercises the installed CLI against a local model stub, without API charges or user config changes.
it.skipIf(process.env.ORCA_CANVAS_CLI_SMOKE !== '1' || process.platform === 'win32')(
  'Claude CLI includes native canvas context in the model request',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-canvas-cli-'))
    const sessionId = randomUUID()
    const launchToken = randomUUID()
    const marker = `CANVAS_${randomUUID()}`
    const prompt = 'Reply with the attached canvas marker. Do not use tools.'
    const modelRequests: string[] = []
    const model = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) {
        body += chunk
      }
      if (!request.url?.startsWith('/v1/messages')) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{}')
        return
      }
      modelRequests.push(body)
      const message = {
        id: 'msg_canvas',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 }
      }
      const frames = [
        { type: 'message_start', message },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Native context checked.' }
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 5 }
        },
        { type: 'message_stop' }
      ]
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(
        frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('')
      )
    })
    const hooks = new AgentHookServer()
    try {
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
      const address = model.address()
      if (!address || typeof address === 'string') {
        throw new Error('Missing model endpoint')
      }
      await hooks.start({ env: 'production' })
      await hooks.canvasContexts.replace(
        {
          canvasId: 'cli-test',
          revision: 1,
          bindings: [
            {
              nodeId: 'agent',
              paneKey: PANE,
              worktreeId: directory,
              ptyId: 'test-pty',
              provider: 'claude',
              notes: [{ id: 'note', title: 'Reference', content: marker }]
            }
          ]
        },
        new Map([
          [
            'agent',
            { sessionId, launchTokenHash: createHash('sha256').update(launchToken).digest('hex') }
          ]
        ])
      )
      const memory = createAgentHookMemorySftp()
      await new ClaudeHookService().installRemote(memory.sftp, directory)
      const script = [...memory.fs.files.entries()].find(([path]) =>
        path.endsWith('/claude-hook.sh')
      )?.[1]
      if (!script) {
        throw new Error('Missing managed hook')
      }
      const scriptPath = join(directory, 'context-hook.sh')
      await writeFile(scriptPath, script, { mode: 0o700 })
      const settings = {
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: `/bin/sh '${scriptPath}'` }] }]
        }
      }
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith('ORCA_') &&
            !key.startsWith('CLAUDE') &&
            !key.startsWith('ANTHROPIC') &&
            !key.startsWith('DEVIN')
        )
      )
      const result = await runProcess({
        program: 'claude',
        cwd: directory,
        args: [
          '-p',
          prompt,
          '--model',
          'haiku',
          '--tools',
          '',
          '--max-turns',
          '1',
          '--session-id',
          sessionId,
          '--no-session-persistence',
          '--setting-sources',
          '',
          '--settings',
          JSON.stringify(settings),
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}'
        ],
        env: {
          ...env,
          ...hooks.buildPtyEnv(),
          ORCA_AGENT_HOOK_ENDPOINT: '',
          ORCA_PANE_KEY: PANE,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: directory,
          ORCA_AGENT_LAUNCH_TOKEN: launchToken,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          ANTHROPIC_API_KEY: 'canvas-local-test-key',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
        },
        timeoutMs: 30_000
      })
      expect(result.code, result.stderr).toBe(0)
      expect(modelRequests.some((body) => body.includes(marker))).toBe(true)
      expect(hooks.getStatusSnapshot()[0].prompt).toBe(prompt)
    } finally {
      hooks.stop()
      model.closeAllConnections()
      await new Promise<void>((resolve) => model.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  },
  40_000
)

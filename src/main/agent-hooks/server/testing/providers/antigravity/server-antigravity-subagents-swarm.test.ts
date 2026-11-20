import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, postHookEvent } from '../../server.test-fixtures'

it('publishes hook-observed workers with shared row details and retires them on idle Stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-agy-workers-'))
  const server = new AgentHookServer()
  const root = '10000000-0000-4000-8000-000000000001'
  const child = '20000000-0000-4000-8000-000000000001'
  const paths = new Map<string, string>()
  for (const id of [root, child]) {
    const logs = join(dir, 'brain', id, '.system_generated', 'logs')
    mkdirSync(logs, { recursive: true })
    const path = join(logs, 'transcript.jsonl')
    writeFileSync(
      path,
      `${JSON.stringify({ source: id === root ? 'USER_EXPLICIT' : 'SYSTEM', type: id === root ? 'USER_INPUT' : 'SYSTEM_MESSAGE', content: id === root ? 'Audit auth' : 'sender=root' })}\n`
    )
    paths.set(id, path)
  }
  const swarm = join(dir, 'brain', root, '.system_generated', 'swarm')
  mkdirSync(swarm, { recursive: true })
  writeFileSync(
    join(swarm, 'members.json'),
    JSON.stringify({
      members: {
        auth_audit: {
          conversation_id: child,
          phase: 'RUNNING',
          wake_mode: 'working',
          applied_model: 'model-b'
        }
      }
    })
  )
  const hook = async (
    id: string,
    name: string,
    extra: Record<string, unknown> = {}
  ): Promise<void> => {
    const response = await postHookEvent(
      server,
      buildBody(
        { conversationId: id, transcriptPath: paths.get(id), ...extra },
        { hookEventName: name }
      ),
      '/hook/antigravity'
    )
    expect(response.status).toBe(204)
  }
  try {
    await server.start({ env: 'production', userDataPath: dir })
    await hook(root, 'PreInvocation', { lastUserInput: 'Audit auth', modelName: 'model-a' })
    await hook(root, 'PreToolUse', { toolCall: { name: 'swarm_wait' } })
    expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
    await hook(child, 'PreInvocation')
    await hook(child, 'PreToolUse', {
      toolCall: { name: 'read_file', args: { path: 'src/auth.ts' } }
    })
    await vi.waitFor(
      () =>
        expect(server.getStatusSnapshot()[0]?.subagents?.[0]).toMatchObject({
          id: child,
          description: 'auth_audit',
          agentType: 'Swarm Worker',
          model: 'model-b',
          toolName: 'read_file',
          toolInput: 'src/auth.ts'
        }),
      { timeout: 10000 }
    )
    expect(server.getStatusSnapshot()[0]?.providerSession?.id).toBe(root)
    await hook(child, 'PreToolUse', {
      toolCall: { name: 'ask_question', args: { question: 'Continue?' } }
    })
    await vi.waitFor(() => expect(server.getStatusSnapshot()[0]?.state).toBe('waiting'), {
      timeout: 10000
    })
    await hook(root, 'Stop', { fullyIdle: false })
    await hook(child, 'Stop', { fullyIdle: true })
    await vi.waitFor(() => expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined(), {
      timeout: 10000
    })
    await hook(root, 'Stop', { fullyIdle: true })
    expect(server.getStatusSnapshot()[0]?.state).toBe('done')
    await hook(child, 'PostToolUse', { toolCall: { name: 'read_file' } })
    expect(server.getStatusSnapshot()[0]?.state).toBe('done')
  } finally {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

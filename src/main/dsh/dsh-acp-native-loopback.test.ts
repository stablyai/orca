import { createServer } from 'node:http'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  appendFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { DshStructuredSessionAdapter } from './dsh-structured-session-adapter'
import { openDshAcpConnection, type DshAcpConnection } from './dsh-acp-connection'
import { supportsDshAcpVersion } from './dsh-structured-launch-resolution'

// Actual installed official CLI; every model response below is a synthetic localhost fixture.
const prefix = process.env.ORCA_DSH_ACP_REAL_CLI_PREFIX
describe.skipIf(!prefix)('pinned official CLI against a private synthetic provider', () => {
  it('runs tools, one-shot permission, options, cancellation and persisted resume through Orca', async () => {
    if (!prefix) {
      throw new Error('Native proof requires an installed official CLI prefix')
    }
    const entry = process.env.ORCA_DSH_ACP_REAL_CLI_OUTPUT_DIR ?? tmpdir()
    mkdirSync(entry, { recursive: true })
    const root = mkdtempSync(join(entry, 'official-adapter-proof-')),
      home = join(root, 'dsh-home'),
      cwd = join(root, 'folder')
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd)
    writeFileSync(
      join(home, 'cordis.patch.yml'),
      '- id: deepseek-account\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: session-log-deepseek\n  disabled: true\n- id: plugin-package-inventory-deepseek\n  disabled: true\n'
    )
    const cli = realpathSync(join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
    const packageText = readFileSync(
      join(prefix, 'node_modules/@deepseek-ai/dsh/package.json'),
      'utf8'
    )
    writeFileSync(
      join(root, 'binding.json'),
      JSON.stringify(
        {
          cli,
          cliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
          packageText,
          actualCLI: true,
          syntheticModel: true,
          modelAuthentication: false
        },
        null,
        2
      )
    )
    const nativeExits: { pid: number | undefined; code: number | null; signal: string | null }[] =
      []
    let phase: 'tool' | 'hold' = 'tool',
      modelCalls = 0,
      held = false
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        appendFileSync(
          join(root, 'provider.jsonl'),
          `${JSON.stringify({ phase, url: request.url, body })}\n`
        )
        expect(request.url).toBe('/anthropic/v1/messages')
        if (phase === 'hold') {
          held = true
          return
        }
        modelCalls += 1
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const emit = (value: { type: string } & Record<string, unknown>) =>
          response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
        emit({
          type: 'message_start',
          message: { id: 'task-synthetic', usage: { input_tokens: 32, output_tokens: 0 } }
        })
        if (modelCalls === 1) {
          emit({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' }
          })
          emit({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'Synthetic fixture thought.' }
          })
          emit({ type: 'content_block_stop', index: 0 })
          emit({
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'synthetic-write', name: 'write', input: {} }
          })
          emit({
            type: 'content_block_delta',
            index: 1,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify({
                file_path: join(cwd, 'fixture.txt'),
                content: 'Task synthetic tool output.\n',
                sandbox_permissions: 'danger-full-access',
                justification: 'Controlled task fixture writes only its own nonce file.'
              })
            }
          })
          emit({ type: 'content_block_stop', index: 1 })
        } else {
          emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
          emit({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Synthetic model fixture complete.' }
          })
          emit({ type: 'content_block_stop', index: 0 })
        }
        emit({
          type: 'message_delta',
          delta: { stop_reason: modelCalls === 1 ? 'tool_use' : 'end_turn' },
          usage: { output_tokens: 12 }
        })
        emit({ type: 'message_stop' })
        response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Missing loopback fixture address')
    }
    const env = {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TELEMETRY_MODE: 'DISABLED',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/anthropic`,
      DEEPSEEK_API_KEY: 'task-synthetic-not-real'
    }
    const version = await runProcess({
      program: process.execPath,
      args: [cli, '--version'],
      cwd,
      env,
      timeoutMs: 20_000
    })
    writeFileSync(join(root, 'version.json'), JSON.stringify(version, null, 2))
    expect(version.code).toBe(0)
    expect(version.stdout.trim()).toBe('0.2.1-alpha.1')
    expect(supportsDshAcpVersion(version.stdout)).toBe(true)
    const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
    let connection: DshAcpConnection | undefined, resumeSessionId: string | undefined
    const lifecycle = vi.fn()
    const adapter = new DshStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: process.execPath,
        args: [cli, '--profile', 'acp'],
        env,
        cwd,
        ...(resumeSessionId ? { resumeSessionId } : {})
      }),
      onLifecycleEvent: lifecycle,
      onDispatchSettledLate: () => undefined,
      openConnection: async (launch, handlers) => {
        connection = await openDshAcpConnection(launch, handlers, (spec) => {
          const child = spawnProcess(spec)
          child.stdout.on('data', (chunk) => appendFileSync(join(root, 'stdio.stdout.raw'), chunk))
          child.stderr.on('data', (chunk) => appendFileSync(join(root, 'stdio.stderr.raw'), chunk))
          child.on('exit', (code, signal) => {
            nativeExits.push({ pid: child.pid, code, signal })
            writeFileSync(join(root, 'native-exits.json'), JSON.stringify(nativeExits, null, 2))
          })
          return child
        })
        return connection
      }
    })
    const identity = {
      sessionId: 'official-native-proof',
      workspaceId: 'own-folder',
      hostId: 'local',
      agent: 'dsh-acp' as const,
      providerHandle: { kind: 'opaque' as const, agent: 'dsh-acp' as const, value: 'pending' }
    }
    const events = {
      appendItem: (key: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
        items.push({ identity: key, body })
        appendFileSync(join(root, 'journal.jsonl'), `${JSON.stringify({ identity: key, body })}\n`)
      },
      appendTombstone: () => undefined,
      publish: () => undefined
    }
    try {
      const acquired = await adapter.acquire({
        identity,
        fence: 1,
        spawnToken: 'official-native-token-1',
        events
      })
      writeFileSync(join(root, 'acquisition.json'), JSON.stringify(acquired, null, 2))
      expect(acquired.link.handle.provider).toBe('dsh-acp')
      if (acquired.link.handle.provider !== 'dsh-acp' || !connection) {
        throw new Error('Missing official native session')
      }
      resumeSessionId = acquired.link.handle.sessionId
      const options = await adapter.readOptions({ sessionId: identity.sessionId, fence: 1 })
      writeFileSync(join(root, 'options.json'), JSON.stringify(options, null, 2))
      expect(options.models.some((model) => model.id === options.current.model)).toBe(true)
      const effort = options.models
        .find((model) => model.id === options.current.model)
        ?.efforts.find((value) => value.value !== options.current.effort)
      if (effort) {
        await adapter.setOption({
          sessionId: identity.sessionId,
          fence: 1,
          key: 'effort',
          value: effort.value
        })
      }
      await adapter.dispatch({
        sessionId: identity.sessionId,
        fence: 1,
        clientMessageId: 'tool-prompt',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [
            {
              type: 'text',
              text: 'Task synthetic provider fixture: write only the owned fixture file.'
            }
          ]
        }
      })
      await vi.waitFor(
        () => expect(items.some((item) => item.body.kind === 'approval')).toBe(true),
        { timeout: 15_000 }
      )
      const permission = items.find((item) => item.body.kind === 'approval')
      if (!permission || permission.body.kind !== 'approval') {
        throw new Error('Missing native permission')
      }
      const option = permission.body.options.find((value) => value.id === 'allow-once')
      if (!option) {
        throw new Error('Official CLI did not offer allow-once')
      }
      await adapter.answerPrompt({
        sessionId: identity.sessionId,
        fence: 1,
        itemId: agentJournalItemKey(permission.identity),
        kind: 'approval',
        response: { kind: 'option', optionId: option.id },
        commit: async () => undefined
      })
      await vi.waitFor(
        () =>
          expect(
            items.some((item) => item.body.kind === 'turn' && item.body.outcome === 'success')
          ).toBe(true),
        { timeout: 15_000 }
      )
      expect(readFileSync(join(cwd, 'fixture.txt'), 'utf8')).toBe('Task synthetic tool output.\n')
      expect(
        items.some((item) => item.body.kind === 'message' && item.body.role === 'reasoning')
      ).toBe(true)
      expect(
        items.some((item) => item.body.kind === 'tool-call' && item.body.state === 'completed')
      ).toBe(true)
      expect(modelCalls).toBe(2)
      phase = 'hold'
      await adapter.dispatch({
        sessionId: identity.sessionId,
        fence: 1,
        clientMessageId: 'cancel-prompt',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Task synthetic hanging provider for cancellation.' }]
        }
      })
      await vi.waitFor(() => expect(held).toBe(true), { timeout: 15_000 })
      await expect(
        adapter.cancelTurn({ sessionId: identity.sessionId, fence: 1 })
      ).resolves.toEqual({ cancelled: true })
      await vi.waitFor(() =>
        expect(
          items.some((item) => item.body.kind === 'turn' && item.body.outcome === 'cancellation')
        ).toBe(true)
      )
      await expect(adapter.closeSession(identity.sessionId)).resolves.toBe(true)
      adapter.acknowledgeSessionRelease(identity.sessionId)
      const resumed = await adapter.acquire({
        identity,
        fence: 2,
        spawnToken: 'official-native-token-2',
        events
      })
      expect(resumed.link).toMatchObject({
        origin: 'resumed',
        mintedAtFence: 2,
        handle: { sessionId: resumeSessionId }
      })
      writeFileSync(join(root, 'resumed.json'), JSON.stringify(resumed, null, 2))
      await expect(adapter.closeSession(identity.sessionId)).resolves.toBe(true)
      expect(nativeExits).toHaveLength(2)
      expect(nativeExits.every((exit) => exit.code === 0)).toBe(true)
      expect(lifecycle).not.toHaveBeenCalled()
      writeFileSync(
        join(root, 'verdict.json'),
        JSON.stringify(
          {
            actualCLI: true,
            syntheticModel: true,
            modelAuthentication: false,
            provider: 'task-owned localhost only',
            positivePhysicalExits: nativeExits,
            sourceControlsPassed: true
          },
          null,
          2
        )
      )
    } finally {
      await adapter.closeAll()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 60_000)
})

import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { PiRpcSessionAdapter } from './rpc-session-adapter'
import { AgentSessionAcquisitionRootExitObservedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { JsonlRpcAgentConnection } from '../jsonl-rpc/agent-connection'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'

afterEach(closeProviderTimelineRigs)

it.skipIf(!process.env.ORCA_REAL_PI_BINARY)(
  'runs a real Pi extension wake through the adapter and journal without another host prompt',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-pi-wake-'))
    const requests: string[] = []
    const records: JsonlRpcRecord[] = []
    const logger = { warn: vi.fn(), error: vi.fn() }
    let rig: Awaited<ReturnType<typeof openProviderTimelineRig>> | undefined
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) {
        body += chunk.toString()
      }
      requests.push(body)
      const text = body.includes('BACKGROUND_RESULT')
        ? 'BACKGROUND_RESULT_CONSUMED'
        : 'BACKGROUND_REVIEW_STARTED'
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (
        delta: { role?: 'assistant'; content?: string },
        finish_reason: string | null
      ) => ({
        id: `completion-${requests.length}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'wake-test',
        choices: [{ index: 0, delta, finish_reason }]
      })
      response.write(
        `data: ${JSON.stringify(chunk({ role: 'assistant', content: text }, null))}\n\n`
      )
      response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    let adapter: PiRpcSessionAdapter | undefined
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('No test server port')
      }
      const agentDir = join(root, 'agent')
      await mkdir(agentDir)
      rig = await openProviderTimelineRig({ agent: 'pi', sessionId: 'session-timeline' })
      const journal = rig
      const idle = vi.fn(),
        settled = vi.fn(),
        lifecycle = vi.fn()
      adapter = new PiRpcSessionAdapter({
        openConnection: (launch, handlers) =>
          new JsonlRpcAgentConnection(launch, {
            ...handlers,
            onRecord: (frame) => {
              records.push(frame)
              handlers.onRecord?.(frame)
            }
          }),
        resolveLaunch: async () => ({
          command: process.env.ORCA_REAL_PI_BINARY!,
          cwd: root,
          fullAccess: true,
          previous: null,
          extraArgs: [
            '--no-extensions',
            '--no-skills',
            '--no-prompt-templates',
            '--no-themes',
            '-e',
            join(import.meta.dirname, '__fixtures__', 'extension-wake.mjs'),
            '--provider',
            'orca-wake-test',
            '--model',
            'wake-test',
            '--thinking',
            'off'
          ],
          env: {
            PI_CODING_AGENT_DIR: agentDir,
            ORCA_BACKGROUND_LAUNCH: '1',
            ORCA_PI_WAKE_BASE_URL: `http://127.0.0.1:${address.port}/v1`
          }
        }),
        onLifecycle: lifecycle,
        onSettled: settled,
        onIdle: idle,
        logger
      })
      const acquired = await adapter.acquire({
        identity: {
          sessionId: 'session-timeline',
          workspaceId: 'folder-test',
          hostId: 'local',
          agent: 'pi',
          providerHandle: null
        },
        fence: 1,
        spawnToken: 'isolated-wake-test',
        events: rig.eventSink
      })
      await adapter.dispatch({
        sessionId: 'session-timeline',
        fence: 1,
        clientMessageId: 'only-host-input',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Review in background.' }]
        }
      })
      await vi.waitFor(
        async () => {
          expect((await journal.turns()).map((turn) => turn.outcome)).toEqual([
            'success',
            'success'
          ])
        },
        { timeout: 20_000, interval: 50 }
      )
      expect(requests).toHaveLength(2)
      expect(requests[1]).toContain('BACKGROUND_RESULT: review complete, no issues.')
      expect(
        (await rig.rows()).filter((row) => row.body.kind === 'message').map((row) => row.body)
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            blocks: [{ type: 'text', text: 'BACKGROUND_RESULT_CONSUMED' }]
          })
        ])
      )
      expect(settled).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          clientMessageId: 'only-host-input',
          outcome: expect.objectContaining({ state: 'accepted' })
        })
      )
      expect(idle).toHaveBeenCalledTimes(2)
      expect(lifecycle).not.toHaveBeenCalled()
      expect(logger.error).not.toHaveBeenCalled()
      if (!acquired.link) {
        throw new Error('Pi did not publish its session file')
      }
      const transcript = await readFile(acquired.link.handle.nativeId, 'utf8')
      expect(transcript).toContain('subagent-notify')
      expect(transcript).toContain('BACKGROUND_RESULT_CONSUMED')
    } finally {
      const proofDir = process.env.ORCA_PI_WAKE_PROOF_DIR
      if (proofDir) {
        await mkdir(proofDir, { recursive: true })
        await writeFile(
          join(proofDir, 'rpc-wake.json'),
          JSON.stringify(
            {
              platform: process.platform,
              requests,
              records,
              turns: await rig?.turns(),
              errors: logger.error.mock.calls.map((args) =>
                args.map((value) =>
                  JSON.stringify(value, (_key, item) =>
                    item instanceof Error ? item.message : item
                  )
                )
              )
            },
            null,
            2
          )
        )
      }
      await adapter?.closeAll().catch((error: unknown) => {
        if (!(error instanceof AgentSessionAcquisitionRootExitObservedError)) {
          throw error
        }
      })
      await adapter?.drainObservedExits()
      adapter?.acknowledgeSessionRelease('session-timeline')
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)

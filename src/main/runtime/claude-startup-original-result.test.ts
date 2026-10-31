import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnProcess } from '@orca/process-host'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime-contract'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import {
  openClaudeStreamJsonConnection,
  ClaudeControlRequestError
} from '../claude/claude-stream-json-connection'
import {
  createTestParams,
  CREATE_TEST_CALLER as CALLER
} from '../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import {
  hostTestMessage,
  HOST_TEST_SESSION as SESSION
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createStructuredAgentSessionOperationId } from '../../shared/structured-agent-session-mutation'
import { providerStartupFailureFact } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

let directory: string | undefined
let releaseOpen: (() => void) | undefined
afterEach(async () => {
  releaseOpen?.()
  await stopStructuredAgentSessionRuntime()
  vi.restoreAllMocks()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

const materialized = (
  await readFile(resolve('node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'), 'utf8')
).includes('receiveCompleted')
for (const mode of ['default', 'external'] as const) {
  it.skipIf(mode === 'external' && !materialized).each(['open-first', 'end-first'] as const)(
    `${mode}: preserves initialize refusal through cleanup SIGTERM with %s`,
    async (schedule) => {
      directory = await mkdtemp(join(tmpdir(), 'orca-startup-original-'))
      const root = directory
      await mkdir(join(root, 'claude-home'))
      const scenario = join(root, 'scenario.json')
      await writeFile(
        scenario,
        JSON.stringify({
          controlErrors: { initialize: 'original initialize refusal' },
          controlErrorAfterFile: join(root, 'open-started'),
          steps: [{ awaitControlRequest: 'initialize' }, { delayMs: 60_000 }]
        })
      )
      const logged: unknown[] = []
      const originalResults: unknown[] = []
      const received: { toolId: string; content: string }[] = []
      const signals: (NodeJS.Signals | null)[] = []
      const deps: StructuredAgentSessionRuntimeDeps = {
        stateDirectory: root,
        hostId: 'local',
        claimKeyId: 'startup-original',
        resolveWorkspacePath: async () => root,
        resolveEnvironment: async () => ({
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: root,
          USERPROFILE: root,
          XDG_CONFIG_HOME: root,
          XDG_DATA_HOME: root,
          XDG_CACHE_HOME: root,
          CODEX_HOME: root,
          CLAUDE_CONFIG_DIR: join(root, 'claude-home'),
          ORCA_SDK_CONTRACT_SCENARIO_PATH: scenario,
          ORCA_BACKGROUND_LAUNCH: '1'
        }),
        resolveClaudeCommand: () => ({
          command: resolve('src/main/claude/__fixtures__/claude-agent-sdk-scripted-cli.mjs'),
          prefixArgs: []
        }),
        resolveLaunchArgs: () => [],
        resolveClaudeAuthPolicy: () => ({ account: 'system' }),
        logger: {
          error: () => {},
          warn: (_message, detail) => {
            if (detail.scope === 'provider-open-failed') {
              logged.push(detail.error)
            }
          }
        },
        openClaudeConnection: async (launch, handlers) => {
          const toolId = randomUUID()
          const content = `complete received result ${toolId}`
          received.push({ toolId, content })
          await writeFile(
            scenario,
            JSON.stringify({
              controlErrors: { initialize: 'original initialize refusal' },
              controlErrorAfterFile: join(root, 'open-started'),
              controlResponseLeadingFrames: {
                initialize: [
                  {
                    type: 'user',
                    uuid: randomUUID(),
                    session_id: launch.options.sessionId,
                    parent_tool_use_id: null,
                    message: {
                      role: 'user',
                      content: [{ type: 'tool_result', tool_use_id: toolId, content }]
                    }
                  }
                ]
              },
              steps: [{ awaitControlRequest: 'initialize' }, { delayMs: 60_000 }]
            })
          )
          const connection = await openClaudeStreamJsonConnection(
            launch,
            handlers,
            (spec) => {
              const child = spawnProcess(spec)
              child.once('exit', (_code, signal) => {
                signals.push(signal)
              })
              return child
            },
            (params) =>
              query({
                ...params,
                options: {
                  ...params.options,
                  ...(mode === 'default' ? { processReceiveLifecycle: undefined } : {})
                }
              })
          )
          void connection.initializationResult().catch((error: unknown) => {
            originalResults.push(error)
            if (schedule === 'end-first') {
              void connection.closeOutcome()
            }
          })
          return connection
        }
      }
      const host = await ensureStructuredAgentSessionHost(deps)
      const open = host.deps.adapter.open.bind(host.deps.adapter)
      const barrier = Promise.withResolvers<void>()
      releaseOpen = () => barrier.resolve()
      vi.spyOn(host.deps.adapter, 'open').mockImplementation(async (input) => {
        await writeFile(join(root, 'open-started'), '')
        try {
          return await open(input)
        } catch (error) {
          if (schedule === 'end-first') {
            await barrier.promise
          }
          throw error
        }
      })
      const params = createTestParams(undefined, {
        provider: 'claude',
        agent: 'claude',
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') }
      })
      params.envelope.clientOperationId = createStructuredAgentSessionOperationId(randomUUID)
      expect(await host.create(CALLER, params)).toMatchObject({ ok: true })
      const body = hostTestMessage('original send')
      const sent = await host.send(CALLER, {
        body,
        envelope: {
          sessionId: SESSION,
          clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
          expectedRuntimeFence: null,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields: { body }
          })
        }
      })
      expect(sent).toMatchObject({ ok: true })
      await vi.waitFor(
        async () => {
          await host.flushStreamedEvents(SESSION)
          expect((await host.journalSnapshot(SESSION)).submissions[0]?.dispatchState).toBe(
            'rejected'
          )
        },
        { timeout: 15_000 }
      )
      // The existing policy retries typed refusals; each original Query reports exactly once.
      expect(logged).toHaveLength(originalResults.length)
      expect(logged.length).toBeGreaterThan(0)
      expect(new Set(logged).size).toBe(logged.length)
      for (const error of originalResults) {
        expect(logged).toContain(error)
        expect(error).toBeInstanceOf(ClaudeControlRequestError)
        expect(error).toMatchObject({
          subtype: 'initialize',
          message: 'original initialize refusal'
        })
      }
      const snapshot = await host.journalSnapshot(SESSION)
      expect(snapshot.submissions[0]?.rejection).toEqual(
        providerStartupFailureFact(originalResults.at(-1))
      )
      expect(
        snapshot.items.filter((item) => item.body.kind === 'status' && item.body.failure)
      ).toHaveLength(1)
      expect(signals).toHaveLength(originalResults.length)
      expect(signals.every((signal) => signal === 'SIGTERM')).toBe(true)
      for (const { toolId, content } of received) {
        const rows = snapshot.items.filter((item) => JSON.stringify(item.body).includes(toolId))
        expect(rows).toHaveLength(1)
        expect(JSON.stringify(rows[0].body)).toContain(content)
      }
      expect(
        snapshot.items.flatMap(({ body }) => (body.kind === 'tool-call' ? [body.callId] : []))
      ).toEqual(received.map(({ toolId }) => toolId))
      expect(new Set(snapshot.items.map((item) => item.itemId)).size).toBe(snapshot.items.length)
      await stopStructuredAgentSessionRuntime()
      const reopened = await ensureStructuredAgentSessionHost(deps)
      expect((await reopened.journalSnapshot(SESSION)).items).toEqual(snapshot.items)
    },
    25_000
  )
}

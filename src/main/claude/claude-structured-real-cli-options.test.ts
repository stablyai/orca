// The SDK requests behind the model, effort and permission pickers and the context meter, against
// the live CLI: CI meets them only through stand-ins, which pin the shape we read, not the one the
// CLI sends. Runs only where a signed-in Claude CLI exists, like the rest of the real-CLI suite.

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  claudeProviderHandle,
  claudeProviderHandleLeafUuid
} from '../../shared/agent-session-provider-handle-encoding'
import {
  CLAUDE_STRUCTURED_BASE_OPTIONS,
  claudeStructuredPermissionOptions
} from './claude-structured-launch-resolution'
import { listedModels } from './claude-structured-model-catalog'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'
import {
  realClaudeAuthenticated,
  realClaudeAvailable,
  realClaudeCommand,
  realClaudeLaunchHome
} from './claude-real-cli-availability-test-support'
import { claudeStartupSettled } from './claude-structured-session-test-support'
import { journal } from './claude-context-usage-test-support'

const SESSION_ID = 'real-cli-options'
// The SDK's effort scale, low to high; the CLI's list order is not a contract.
const EFFORT_SCALE = ['low', 'medium', 'high', 'xhigh', 'max']

function identity(providerSessionId: string, leafUuid: string | null): AgentSessionJournalIdentity {
  return {
    sessionId: SESSION_ID,
    workspaceId: 'real-cli-options-workspace',
    hostId: 'local',
    agent: 'claude',
    providerHandle: claudeProviderHandle(providerSessionId, leafUuid)
  }
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return check()
}

// Inits name a 1M-window model with `[1m]`; context reports and responses drop it.
const baseModelId = (model: string): string =>
  model
    .replace(/\[[^\]]*\]$/u, '')
    .trim()
    .toLowerCase()

describe.skipIf(!realClaudeAvailable)('Claude structured real CLI options', () => {
  it.skipIf(!realClaudeAuthenticated)(
    'applies a message model and effort, reports context usage, and relaunches into a new permission mode',
    async () => {
      const providerSessionId = randomUUID()
      const { claudeConfigDir, env } = realClaudeLaunchHome()
      const cwd = await mkdtemp(join(tmpdir(), 'orca-real-options-'))
      const events: ClaudeStructuredSessionEvent[] = []
      const record = journal()
      const persisted: { leafUuid: string | null } = { leafUuid: null }
      let launches = 0
      const adapter = new ClaudeStructuredSessionAdapter({
        resolveLaunch: async ({ identity: launchIdentity, permissionMode }) => {
          const permission = claudeStructuredPermissionOptions(permissionMode ?? 'ask')
          // A relaunch resumes the transcript the first launch wrote, as the host's resolver does.
          const resumes = launches++ > 0
          return {
            pathToClaudeCodeExecutable: realClaudeCommand,
            options: {
              ...CLAUDE_STRUCTURED_BASE_OPTIONS,
              ...permission,
              extraArgs: { ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs, ...permission.extraArgs },
              ...(resumes ? { resume: providerSessionId } : { sessionId: providerSessionId })
            },
            cwd,
            env,
            claudeConfigDir,
            providerSessionId,
            resumeLeafUuid:
              resumes && launchIdentity.providerHandle
                ? claudeProviderHandleLeafUuid(launchIdentity.providerHandle)
                : null,
            resumesTranscript: resumes,
            continuesChain: resumes
          }
        },
        onEvent: (event) => events.push(event),
        persistHandle: async (handle) => {
          persisted.leafUuid = handle.leafUuid
        },
        readProcessStartTime: async () => 1
      })
      const frames = (from: number) =>
        events.slice(from).flatMap((event) => (event.type === 'message' ? [event.message] : []))
      const inits = (from: number) =>
        frames(from).filter((message) => message.type === 'system' && message.subtype === 'init')
      const results = (from: number) => frames(from).filter((message) => message.type === 'result')
      const send = (
        clientMessageId: string,
        text: string,
        fence: number,
        executionOptions?: AgentSessionExecutionOptions
      ) =>
        adapter.dispatch({
          sessionId: SESSION_ID,
          clientMessageId,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
          requestedAt: Date.now(),
          fence,
          ...(executionOptions ? { executionOptions } : {})
        })
      const contextReport = () =>
        record
          .items()
          .flatMap((row) => {
            const used = readAgentJournalTurn(row.body)?.contextUsage?.used
            return used?.kind === 'report' ? [used] : []
          })
          .at(-1)

      try {
        await adapter.acquire({
          identity: identity(providerSessionId, null),
          fence: 1,
          spawnToken: 'real-cli-options-1',
          permissionMode: 'ask',
          events: record.sink
        })
        await claudeStartupSettled(adapter, SESSION_ID)

        // A row without `value` or `resolvedModel` silently turns off the admit check, the effort
        // guard and model confirmation.
        const connection = adapter['sessions'].get(SESSION_ID)?.connection
        if (!connection) {
          throw new Error('no live Claude connection')
        }
        const listed = listedModels({ models: await connection.supportedModels() })
        const rows = ['haiku', 'sonnet'].map((alias) => listed.find(({ id }) => id === alias))
        for (const row of rows) {
          expect(row?.resolvedModel).toEqual(expect.stringMatching(/\S/u))
        }
        const opened = await adapter.readOptions({ sessionId: SESSION_ID, fence: 1 })
        expect(opened.catalogListing?.models.map(({ id }) => id)).toContain('haiku')

        const pick = rows.find((row) => row !== undefined && row.efforts.length > 0)
        const level = pick?.efforts
          .map(({ value }) => value)
          .filter((value) => EFFORT_SCALE.includes(value))
          .sort((left, right) => EFFORT_SCALE.indexOf(left) - EFFORT_SCALE.indexOf(right))[0]
        if (!pick?.resolvedModel || !level) {
          throw new Error('neither haiku nor sonnet lists an effort level')
        }

        // The production send path: list_models, set_model, apply_flag_settings and get_settings.
        // `ranOptions` carries only what the CLI reported; it names the resolved id, so an alias
        // pick reports no model and the recorder falls back to the message's own pick.
        const firstTurn = events.length
        const outcome = await send(
          'real-cli-options-1',
          'Reply with exactly: OK. Do not use any tools.',
          1,
          { model: pick.id, effort: level }
        )
        expect(outcome).toMatchObject({ state: 'admitted', ranOptions: { effort: level } })
        expect([undefined, pick.id]).toContain(
          'ranOptions' in outcome ? outcome.ranOptions?.model : undefined
        )
        expect(await until(() => results(firstTurn).length > 0, 90_000)).toBe(true)
        expect(results(firstTurn)[0]).toMatchObject({ subtype: 'success', is_error: false })
        expect(inits(firstTurn)[0]?.model).toBe(pick.resolvedModel)
        // Effort is read only through get_settings; no frame carries it, init included.
        expect(frames(0).filter((frame) => 'effortLevel' in frame)).toEqual([])
        await expect(
          adapter.readOptions({ sessionId: SESSION_ID, fence: 1 })
        ).resolves.toMatchObject({
          current: {
            model: pick.id,
            effort: level,
            confirmed: expect.arrayContaining(['model', 'effort'])
          }
        })

        // The turn end asks get_context_usage; an answer Orca cannot read blanks the meter silently.
        expect(await until(() => contextReport() !== undefined, 10_000)).toBe(true)
        const report = contextReport()
        if (!report) {
          throw new Error('no context report on any turn row')
        }
        expect(report.usedTokens).toBeGreaterThan(0)
        expect(report.windowTokens).toBeGreaterThanOrEqual(report.usedTokens)
        expect(report.model).toMatch(/\S/u)
        expect(baseModelId(report.model)).toBe(baseModelId(pick.resolvedModel))

        // Orca never sends set_permission_mode: it retires the child and resumes it under the new
        // flag with the saved picks, so the CLI must read its mode at launch.
        await adapter.closeSession(SESSION_ID)
        const resumedTurn = events.length
        await adapter.acquire({
          identity: identity(providerSessionId, persisted.leafUuid),
          fence: 2,
          spawnToken: 'real-cli-options-2',
          permissionMode: 'accept-edits',
          options: { model: pick.id, effort: level },
          events: record.sink
        })
        await claudeStartupSettled(adapter, SESSION_ID)
        await expect(
          send('real-cli-options-2', 'Reply with exactly: OK.', 2)
        ).resolves.toMatchObject({
          state: 'admitted'
        })
        expect(await until(() => results(resumedTurn).length > 0, 90_000)).toBe(true)
        expect(results(resumedTurn)[0]).toMatchObject({ subtype: 'success', is_error: false })
        expect(inits(resumedTurn)[0]).toMatchObject({
          session_id: providerSessionId,
          permissionMode: 'acceptEdits',
          model: pick.resolvedModel
        })
        await expect(
          adapter.readOptions({ sessionId: SESSION_ID, fence: 2 })
        ).resolves.toMatchObject({ current: { effort: level } })
      } finally {
        await adapter.closeAll()
        await rm(cwd, { recursive: true, force: true })
      }
    },
    180_000
  )
})

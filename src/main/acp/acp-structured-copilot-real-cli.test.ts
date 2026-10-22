// The installed, signed-in `copilot` CLI driven through Orca's own ACP lane end to end: the lane's
// launch resolution (release gate included), the real `initialize` / `session/new` handshake, one
// prompt turn, and a Stop. Opt-in (`ORCA_REAL_COPILOT_CLI_TEST=1`); off by default because it
// spawns the real CLI, spends a model turn on the signed-in account, and writes session data into
// that account's home. Also skipped where no `copilot` resolves; a default run stays green.
//
// `ORCA_REAL_COPILOT_CLI_TEST=1 pnpm test src/main/acp/acp-structured-copilot-real-cli.test.ts`

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import {
  TEST_SPAWN_TOKEN,
  createAcpStructuredLaunchResolver
} from '../runtime/structured-agent-launch-composition.test-support'
import { createAcpAgentConnection } from './acp-agent-connection'
import type { AcpSessionEvent } from './acp-session-runtime'
import {
  COPILOT,
  copilotCliPresent,
  streamedReply
} from './acp-structured-copilot-real-cli.test-support'
import { ACP_PROTOCOL_VERSION } from './generated/acp-protocol.generated'

const enabled = process.env.ORCA_REAL_COPILOT_CLI_TEST === '1' && copilotCliPresent()
const REPLY_PROMPT = 'Reply with exactly the word PONG and nothing else.'
// Long enough that the Stop lands mid-turn rather than after the reply.
const CANCEL_PROMPT = 'Write a 400-word story about a lighthouse keeper in a storm.'

describe.skipIf(!enabled)('Copilot real CLI through the ACP lane', () => {
  it('completes the handshake, answers a prompt turn, and stops the next turn on cancel', async () => {
    const base = mkdtempSync(join(tmpdir(), 'orca-real-copilot-'))
    const cwd = join(base, 'workspace')
    mkdirSync(cwd)
    onTestFinished(() => rmSync(base, { recursive: true, force: true }))

    const identity = {
      sessionId: 'copilot-real-cli',
      workspaceId: 'workspace-real-cli',
      hostId: 'local',
      agent: 'copilot',
      providerHandle: null
    }
    const record = {
      ...agentSessionRecordFixture(),
      sessionId: identity.sessionId,
      provider: 'copilot',
      providerHandleChain: [],
      accountHome: {
        variable: 'COPILOT_HOME',
        path: join(homedir(), '.copilot')
      }
    }
    // The lane's composed resolver over a synthetic record and the real environment, as an
    // acquire resolves its launch; its real version probe runs the release gate.
    const resolver = createAcpStructuredLaunchResolver(COPILOT, {
      store: { getRecord: () => record, pinLaunchDirectory: async () => record },
      readJournal: () => null,
      resolveWorkspacePath: async () => cwd,
      resolveEnvironment: async () => process.env,
      resolveLaunchEnv: () => ({}),
      inheritedEnv: process.env
    })
    const launch = await resolver({ identity, spawnToken: TEST_SPAWN_TOKEN })
    expect(launch.args).toEqual(['--acp', '--stdio'])
    const connection = createAcpAgentConnection(
      {
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        envToDelete: launch.envToDelete
      },
      { clientInfo: { name: 'orca', version: '1' } }
    )
    onTestFinished(async () => {
      await connection.close().catch(() => {})
    })
    const events: AcpSessionEvent[] = []
    connection.subscribe((event) => events.push(event))

    const initialized = await connection.initialize()
    expect(initialized.protocolVersion).toBe(ACP_PROTOCOL_VERSION)
    expect(initialized.agentCapabilities?.loadSession).toBe(true)

    const started = await connection.start({ cwd, mcpServers: [] })
    expect(started).toMatchObject({ kind: 'new' })
    expect(started.sessionId.length).toBeGreaterThan(0)
    // Each `session/new` carries the live catalog; `initialize` lists none.
    expect(started.response.models?.availableModels.length).toBeGreaterThan(0)

    const turn = await connection.prompt([{ type: 'text', text: REPLY_PROMPT }])
    expect(turn.stopReason).toBe('end_turn')
    expect(streamedReply(events, started.sessionId).toLowerCase()).toContain('pong')

    const before = events.length
    const cancelled = connection.prompt([{ type: 'text', text: CANCEL_PROMPT }])
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(before), {
      timeout: 30_000,
      interval: 50
    })
    await connection.cancel()
    await expect(cancelled).resolves.toMatchObject({ stopReason: 'cancelled' })
    // The turn ended, not the chat: the agent stays up for the next prompt.
    expect(connection.exited).toBe(false)

    await expect(connection.close()).resolves.toBe(true)
  }, 180_000)
})

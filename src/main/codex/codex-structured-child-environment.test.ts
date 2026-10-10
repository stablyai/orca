import { afterEach, describe, expect, it, vi } from 'vitest'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../shared/agent-session-caller-env'
import { sealStructuredSessionChild } from '../runtime/structured-session-child-env'
import { createCodexStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../runtime/structured-worker-identity'

const DEV_CLI_BIN_FIRST = /^[^:;]*[\\/]cli[\\/]bin[:;]/
const DEV_CLI_BIN_DIR = /^[^:;]*[\\/]cli[\\/]bin$/
// The dev launcher by absolute path: a login shell's profile cannot reorder it behind a global.
const DEV_CLI_LAUNCHER = /^[^:;]*[\\/]cli[\\/]bin[\\/]orca-dev$/

/** The sealed env a Codex launch of `sessionId` spawns with, over a shell env of `env`. */
async function codexChildEnv(
  env: Record<string, string>,
  sessionId: string
): Promise<Record<string, string>> {
  const record = agentSessionRecordFixture({
    sessionId,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/pinned/home' }
  })
  const launch = await createCodexStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveEnvironment: async () => env,
    resolveCommand: () => 'codex',
    resolveLaunchArgs: () => []
  })({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a launch reads only the session id of its identity here.
    identity: { sessionId } as AgentSessionJournalIdentity,
    spawnToken: 'spawn-token'
  })
  return launch.env
}

function sealed(sessionId: string): Record<string, string> {
  return sealStructuredSessionChild({
    sessionId,
    spawnToken: 'spawn-token',
    env: {},
    inheritedEnvToDelete: []
  }).env
}

describe('the Codex child environment', () => {
  it('keeps shell exports while pinned launch values win', async () => {
    expect(
      await codexChildEnv(
        {
          EXAMPLE_GATEWAY_TOKEN: 'shell-exported',
          CODEX_HOME: '/shell/home',
          ORCA_CLI_BIN_DIR: '/inherited/unowned-cli'
        },
        'session-not-a-worker'
      )
    ).toEqual({
      EXAMPLE_GATEWAY_TOKEN: 'shell-exported',
      CODEX_HOME: '/pinned/home',
      [ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV]: 'spawn-token',
      ORCA_AGENT_SESSION_ID: 'session-not-a-worker',
      ORCA_STRUCTURED_SESSION: '1',
      ORCA_CLI_COMMAND: expect.stringMatching(DEV_CLI_LAUNCHER),
      ...(process.platform !== 'win32'
        ? { ORCA_CLI_BIN_DIR: expect.stringMatching(DEV_CLI_BIN_DIR) }
        : {}),
      ORCA_USER_DATA_PATH: expect.any(String),
      // The test host is unpackaged, so this app's CLI is the dev launcher dir, first on PATH.
      PATH: expect.stringMatching(DEV_CLI_BIN_FIRST)
    })
  })

  it('names every session by its id, and adds the handle only for a registered worker', () => {
    const sessionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    expect(sealed(sessionId)).toEqual({
      [ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV]: 'spawn-token',
      // Not a worker, so no handle: the id alone names this chat as a caller.
      ORCA_AGENT_SESSION_ID: sessionId,
      ORCA_STRUCTURED_SESSION: '1',
      ORCA_CLI_COMMAND: expect.stringMatching(DEV_CLI_LAUNCHER),
      ...(process.platform !== 'win32'
        ? { ORCA_CLI_BIN_DIR: expect.stringMatching(DEV_CLI_BIN_DIR) }
        : {}),
      ORCA_USER_DATA_PATH: expect.any(String),
      PATH: expect.stringMatching(DEV_CLI_BIN_FIRST)
    })

    const handle = mintStructuredWorkerHandle()
    structuredWorkerIdentities.register({
      handle,
      sessionId,
      agent: 'codex',
      paneKey: mintStructuredWorkerPaneKey(sessionId),
      processIncarnation: structuredWorkerProcessIncarnation(sessionId),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    try {
      const env = sealed(sessionId)
      expect(env.ORCA_TERMINAL_HANDLE).toBe(handle)
      expect(env.ORCA_AGENT_SESSION_ID).toBe(sessionId)
      expect(env.ORCA_CLI_COMMAND).toMatch(DEV_CLI_LAUNCHER)
      // A pane key here would leak into hook-emitted agent statuses, which assume a PTY leaf.
      expect(env.ORCA_PANE_KEY).toBeUndefined()
    } finally {
      structuredWorkerIdentities.forget(handle)
    }
  })
})

/** A real child speaking Codex's JSONL framing, answering with the environment it was spawned with. */
const ENV_REPORTING_APP_SERVER = String.raw`
  const readline = require('node:readline')
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'initialize') return send({ id: message.id, result: {} })
    if (message.method === 'test/env') {
      return send({
        id: message.id,
        result: {
          sessionId: process.env.ORCA_AGENT_SESSION_ID ?? null,
          cliCommand: process.env.ORCA_CLI_COMMAND ?? null,
          cliBinDir: process.env.ORCA_CLI_BIN_DIR ?? null,
          path: process.env.PATH ?? process.env.Path ?? null
        }
      })
    }
  })
`

describe('the spawned Codex child', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("runs with its own session id and this app's CLI, over an id inherited by Orca itself", async () => {
    // The builder's output is an overlay on process.env, so only the spawned child proves the id
    // survives the merge — an Orca launched inside another session inherits that session's id.
    vi.stubEnv('ORCA_AGENT_SESSION_ID', 'a0b1c2d3-0000-4000-8000-00000000abcd')
    const sessionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    const env = sealed(sessionId)
    const connection = await openCodexAppServerConnection({
      command: process.execPath,
      args: ['-e', ENV_REPORTING_APP_SERVER],
      env
    })
    try {
      await expect(connection.request('test/env')).resolves.toEqual({
        sessionId,
        cliCommand: expect.stringMatching(DEV_CLI_LAUNCHER),
        cliBinDir: process.platform === 'win32' ? null : expect.stringMatching(DEV_CLI_BIN_DIR),
        path: expect.stringMatching(DEV_CLI_BIN_FIRST)
      })
    } finally {
      await connection.close()
    }
  })
})

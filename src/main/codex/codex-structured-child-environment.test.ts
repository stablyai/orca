import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
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
// Absolute launchers survive login-shell PATH reordering.
const DEV_CLI_LAUNCHER = /^[^:;]*[\\/]cli[\\/]bin[\\/]orca-dev$/

async function codexChildEnv(
  env: Record<string, string>,
  sessionId: string,
  command = 'codex'
): Promise<Record<string, string>> {
  const record = agentSessionRecordFixture({
    sessionId,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/pinned/home' }
  })
  const launch = await createCodexStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveEnvironment: async () => env,
    resolveCommand: () => command,
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
      ORCA_ENVIRONMENT: '',
      ORCA_PAIRING_CODE: '',
      ORCA_REMOTE_PAIRING: '',
      // The unpackaged host uses the dev CLI directory.
      PATH: expect.stringMatching(DEV_CLI_BIN_FIRST)
    })
  })

  it('names every session by its id, and adds the handle only for a registered worker', () => {
    const sessionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    expect(sealed(sessionId)).toEqual({
      [ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV]: 'spawn-token',
      ORCA_AGENT_SESSION_ID: sessionId,
      ORCA_STRUCTURED_SESSION: '1',
      ORCA_CLI_COMMAND: expect.stringMatching(DEV_CLI_LAUNCHER),
      ...(process.platform !== 'win32'
        ? { ORCA_CLI_BIN_DIR: expect.stringMatching(DEV_CLI_BIN_DIR) }
        : {}),
      ORCA_USER_DATA_PATH: expect.any(String),
      ORCA_ENVIRONMENT: '',
      ORCA_PAIRING_CODE: '',
      ORCA_REMOTE_PAIRING: '',
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
      // PTY hook statuses must not receive a structured worker's pane key.
      expect(env.ORCA_PANE_KEY).toBeUndefined()
    } finally {
      structuredWorkerIdentities.forget(handle)
    }
  })
})

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
          selectors: [
            process.env.ORCA_ENVIRONMENT,
            process.env.ORCA_PAIRING_CODE,
            process.env.ORCA_REMOTE_PAIRING
          ],
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

  it.skipIf(process.platform === 'win32')(
    'starts the persistent shebang CLI with its sibling Node over a competing PATH runtime',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-codex-shebang-'))
      try {
        const selectedBin = join(root, 'selected', 'bin')
        const competingBin = join(root, 'other', 'bin')
        mkdirSync(selectedBin, { recursive: true })
        mkdirSync(competingBin, { recursive: true })
        symlinkSync(process.execPath, join(selectedBin, 'node'))
        writeFileSync(join(competingBin, 'node'), '#!/bin/sh\nexit 79\n', { mode: 0o755 })
        const command = join(selectedBin, 'codex')
        writeFileSync(command, `#!/usr/bin/env node\n${ENV_REPORTING_APP_SERVER}`, { mode: 0o755 })
        const env = await codexChildEnv({ PATH: competingBin }, 'shebang-session', command)
        const connection = await openCodexAppServerConnection({
          command,
          args: ['app-server'],
          cwd: root,
          env
        })
        try {
          await expect(connection.request('test/env')).resolves.toMatchObject({
            sessionId: 'shebang-session',
            path: expect.stringMatching(DEV_CLI_BIN_FIRST),
            cliCommand: expect.stringMatching(DEV_CLI_LAUNCHER)
          })
          expect(env.PATH.split(delimiter).slice(1)).toEqual([selectedBin, competingBin])
        } finally {
          await connection.close()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it("runs with its own session id and this app's CLI, over an id inherited by Orca itself", async () => {
    // Verify the actual child environment after the overlay merges with inherited process.env.
    vi.stubEnv('ORCA_AGENT_SESSION_ID', 'a0b1c2d3-0000-4000-8000-00000000abcd')
    vi.stubEnv('ORCA_ENVIRONMENT', 'stale-shell-selection')
    vi.stubEnv('ORCA_PAIRING_CODE', 'stale-pairing')
    vi.stubEnv('ORCA_REMOTE_PAIRING', 'stale-remote-pairing')
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
        selectors: ['', '', ''],
        cliBinDir: process.platform === 'win32' ? null : expect.stringMatching(DEV_CLI_BIN_DIR),
        path: expect.stringMatching(DEV_CLI_BIN_FIRST)
      })
    } finally {
      await connection.close()
    }
  })
})

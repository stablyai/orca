import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openCodexAppServerConnection } from '../../app-server/codex-app-server-connection'
import { openCodexThread } from '../threads/codex-structured-thread-open'
import { escapeTomlBasicString } from '../../configuration/toml/config-toml-syntax'
import { existsSync } from 'node:fs'
import { readRecord } from '../../app-server/codex-item-field-readers'
import { codexExecutionLaunch } from './codex-execution-controls'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'

const PROFILE = 'orca-bounded-native-probe'

function nativeArgs(access: 'read-only' | 'workspace') {
  return codexExecutionLaunch(
    agentSessionRecordFixture({
      sessionId: 'native-probe',
      provider: 'codex',
      providerHandleChain: [],
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'probe-folder',
        workspaceKind: 'folder'
      },
      options: { model: 'gpt-live', effort: 'low' },
      executionPolicy: {
        schema: 1,
        sourcePin: 'a'.repeat(40),
        accountFingerprint: `codex:${'b'.repeat(64)}`,
        model: 'gpt-live',
        effort: 'low',
        access,
        // ast-grep-ignore: test-no-wall-clock -- A real native admission needs a future deadline; no assertion depends on elapsed time.
        deadlineAt: Date.now() + 120_000
      }
    })
  )!.args
}

it.skipIf(!process.env.ORCA_CODEX_CONTRACT_BINARY || process.platform === 'win32').each([
  ['read-only', 'readOnly', 'WRITE-DENIED'],
  ['workspace', 'workspaceWrite', 'WRITE-ALLOWED']
] as const)(
  'enforces the %s native profile without model input',
  async (access, sandbox, writeMarker) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-bounded-native-'))
    let connection: Awaited<ReturnType<typeof openCodexAppServerConnection>> | undefined
    try {
      const cwd = join(root, 'workspace')
      const home = join(root, 'account')
      await mkdir(cwd)
      await mkdir(home)
      await writeFile(join(cwd, 'inside.txt'), 'ADMITTED-CANARY')
      await writeFile(join(root, 'outside.txt'), 'PRIVATE-CANARY')
      const marker = join(root, 'mcp-was-started')
      await writeFile(
        join(home, 'config.toml'),
        `sandbox_mode = "danger-full-access"\n[mcp_servers.synthetic_canary]\ncommand = "/usr/bin/touch"\nargs = ["${escapeTomlBasicString(marker)}"]\n`
      )
      const auth = '{"OPENAI_API_KEY":"synthetic-api-key"}'
      await writeFile(join(home, 'auth.json'), auth)
      connection = await openCodexAppServerConnection(
        {
          command: process.env.ORCA_CODEX_CONTRACT_BINARY!,
          args: [...nativeArgs(access), 'app-server'],
          cwd,
          env: { HOME: root, CODEX_HOME: home, ORCA_ROUTING_PARENT_CANARY: 'PARENT-ENV-CANARY' },
          envToDelete: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CHATGPT_BASE_URL']
        },
        {}
      )
      const opened = await openCodexThread(
        connection,
        { cwd, resumeThreadId: null, execution: { profileId: PROFILE } },
        10_000
      )
      expect(opened).toMatchObject({
        activePermissionProfile: { id: PROFILE },
        sandbox: { type: sandbox }
      })
      // The user shell API bypasses the sandbox; command/exec exercises the sandboxed executor.
      const result = await connection.request(
        'command/exec',
        {
          cwd,
          permissionProfile: PROFILE,
          command: [
            '/bin/sh',
            '-c',
            '/bin/cat inside.txt; if /bin/cat ../outside.txt; then /usr/bin/printf READ-ESCAPE; else /usr/bin/printf READ-DENIED; fi; if /usr/bin/touch write.txt; then /usr/bin/printf WRITE-ALLOWED; else /usr/bin/printf WRITE-DENIED; fi; if /usr/bin/touch ../outside-write.txt; then /usr/bin/printf OUTSIDE-WRITE-ESCAPE; else /usr/bin/printf OUTSIDE-WRITE-DENIED; fi; /usr/bin/printenv ORCA_ROUTING_PARENT_CANARY || true'
          ],
          timeoutMs: 5_000
        },
        { timeoutMs: 10_000 }
      )
      const output = readRecord(result).stdout
      expect(output).toContain('ADMITTED-CANARY')
      expect(output).toContain('READ-DENIED')
      expect(output).toContain(writeMarker)
      expect(output).toContain('OUTSIDE-WRITE-DENIED')
      expect(output).not.toContain('PRIVATE-CANARY')
      expect(output).not.toContain('PARENT-ENV-CANARY')
      expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(auth)
      await connection.request(
        'mcpServerStatus/list',
        { threadId: opened.threadId },
        { timeoutMs: 2_000 }
      )
      expect(existsSync(marker)).toBe(false)
    } finally {
      await connection?.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  20_000 // Bounds fresh native startup, command execution and teardown without model inference.
)

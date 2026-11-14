import { codexProjectConfigIsolationArgs } from '../catalog/codex-project-config-isolation'
import { runProcess } from '@orca/process-host'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  openCodexAppServerConnection,
  spawnCodexAppServerConnection
} from '../../app-server/codex-app-server-connection'
import { openCodexThread } from '../threads/codex-structured-thread-open'
import { escapeTomlBasicString } from '../../configuration/toml/config-toml-syntax'
import { existsSync } from 'node:fs'
import { readRecord } from '../../app-server/codex-item-field-readers'
import { codexExecutionLaunch } from './codex-execution-controls'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { CodexStructuredSessionAdapter } from '../session-lifecycle/codex-structured-session-adapter'
import { identityFor } from '../session-lifecycle/codex-structured-session-adapter-fixture'

const PROFILE = 'orca-bounded-native-probe'

function nativeLaunch(access: 'read-only' | 'workspace', deadlineAt?: number) {
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
        deadlineAt: deadlineAt ?? Date.now() + 120_000
      }
    })
  )!
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
      expect((await runProcess({ program: 'git', args: ['init', '--quiet', cwd] })).code).toBe(0)
      await mkdir(home)
      await writeFile(join(cwd, 'inside.txt'), 'ADMITTED-CANARY')
      await writeFile(join(root, 'outside.txt'), 'PRIVATE-CANARY')
      const marker = join(root, 'mcp-was-started')
      const initialConfig = `sandbox_mode = "danger-full-access"\n[features]\nmulti_agent = true\nmemories = true\nmemory_tool = true\n[memories]\ngenerate_memories = true\nuse_memories = true\n[mcp_servers.synthetic_canary]\ncommand = "/usr/bin/touch"\nargs = ["${escapeTomlBasicString(marker)}"]\n`
      await writeFile(join(home, 'config.toml'), initialConfig)
      const auth = '{"OPENAI_API_KEY":"synthetic-api-key"}'
      await writeFile(join(home, 'auth.json'), auth)
      connection = await openCodexAppServerConnection(
        {
          command: process.env.ORCA_CODEX_CONTRACT_BINARY!,
          args: [
            ...nativeLaunch(access).args,
            ...(await codexProjectConfigIsolationArgs(cwd)),
            'app-server'
          ],
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
      expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(initialConfig)
      const config = readRecord(
        await connection.request('config/read', { cwd }, { timeoutMs: 2_000 })
      )
      expect(readRecord(readRecord(config.config).features).multi_agent).toBe(false)
      expect(config.config).toMatchObject({
        features: { memories: false, memory_tool: false },
        memories: { generate_memories: false, use_memories: false }
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

it.skipIf(!process.env.ORCA_CODEX_CONTRACT_BINARY || process.platform === 'win32')(
  'observes root and tree exit after the production acquisition deadline without model input',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-deadline-native-'))
    const home = join(root, 'account')
    await mkdir(home)
    // ast-grep-ignore: test-no-wall-clock -- This opt-in native calibration exercises a real admission timer and process owner.
    const execution = nativeLaunch('read-only', Date.now() + 2_000)
    let connection: Awaited<ReturnType<typeof openCodexAppServerConnection>> | undefined
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: process.env.ORCA_CODEX_CONTRACT_BINARY!,
        args: [...execution.args, 'app-server'],
        cwd: root,
        codexHome: home,
        resumeThreadId: null,
        env: { HOME: root, CODEX_HOME: home },
        envToDelete: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CHATGPT_BASE_URL'],
        execution: { policy: execution.policy, profileId: execution.profileId }
      }),
      openConnection: async (launch, handlers) => {
        connection = await spawnCodexAppServerConnection(launch, handlers)
        return connection
      }
    })
    try {
      const acquired = await adapter.acquire({
        identity: identityFor('native-probe'),
        fence: 7,
        spawnToken: 'bounded-native-probe'
      })
      await adapter.open({
        sessionId: 'native-probe',
        fence: 7,
        acquisitionGeneration: acquired.acquisitionGeneration,
        signal: new AbortController().signal
      })
      // The native process needs time to reach its real deadline and report physical teardown.
      await expect
        .poll(() => connection?.closeResult, { timeout: 5_000 })
        .toMatchObject({ root: 'exited', tree: 'exited' })
    } finally {
      await adapter.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  },
  10_000 // Bounds real native startup, the two-second deadline and process teardown.
)

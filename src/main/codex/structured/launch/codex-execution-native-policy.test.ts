import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openCodexAppServerConnection } from '../../app-server/codex-app-server-connection'
import { codexExecutionProfileArgs } from './codex-execution-controls'

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
      await writeFile(join(home, 'config.toml'), 'sandbox_mode = "danger-full-access"\n')
      connection = await openCodexAppServerConnection(
        {
          command: process.env.ORCA_CODEX_CONTRACT_BINARY!,
          args: [...codexExecutionProfileArgs('orca-bounded', access), 'app-server'],
          cwd,
          env: { HOME: root, CODEX_HOME: home },
          envToDelete: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CHATGPT_BASE_URL']
        },
        {}
      )
      const opened = await connection.request(
        'thread/start',
        {
          cwd,
          permissions: 'orca-bounded',
          runtimeWorkspaceRoots: [cwd],
          approvalPolicy: 'never'
        },
        { timeoutMs: 10_000 }
      )
      expect(opened).toMatchObject({
        activePermissionProfile: { id: 'orca-bounded' },
        sandbox: { type: sandbox }
      })
      // The user shell API bypasses the sandbox; command/exec exercises the sandboxed executor.
      const result = await connection.request(
        'command/exec',
        {
          cwd,
          permissionProfile: 'orca-bounded',
          command: [
            '/bin/sh',
            '-c',
            '/bin/cat inside.txt; if /bin/cat ../outside.txt; then /usr/bin/printf READ-ESCAPE; else /usr/bin/printf READ-DENIED; fi; if /usr/bin/touch write.txt; then /usr/bin/printf WRITE-ALLOWED; else /usr/bin/printf WRITE-DENIED; fi; if /usr/bin/touch ../outside-write.txt; then /usr/bin/printf OUTSIDE-WRITE-ESCAPE; else /usr/bin/printf OUTSIDE-WRITE-DENIED; fi'
          ],
          timeoutMs: 5_000
        },
        { timeoutMs: 10_000 }
      )
      const output = (result as { stdout: string }).stdout
      expect(output).toContain('ADMITTED-CANARY')
      expect(output).toContain('READ-DENIED')
      expect(output).toContain(writeMarker)
      expect(output).toContain('OUTSIDE-WRITE-DENIED')
      expect(output).not.toContain('PRIVATE-CANARY')
    } finally {
      await connection?.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  20_000 // Bounds fresh native startup, command execution and teardown without model inference.
)

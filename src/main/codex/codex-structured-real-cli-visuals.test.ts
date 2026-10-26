import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCodexCommand } from '../codex-cli/command'
import { NATIVE_CHAT_VISUALS_SKILL_NAME } from '../native-chat/native-chat-visuals-skill-location'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { withCodexVisualsThreadConfig } from './codex-structured-visuals'
import { codexStructuredPermissionPolicy } from './codex-structured-permission-policy'

const enabled = process.env.ORCA_REAL_CODEX_CLI_TEST === '1'
const WORKSPACE_POLICY = codexStructuredPermissionPolicy('auto')

describe.skipIf(!enabled)('Codex real app-server chat visuals', () => {
  it('lists the visuals skill and grants the chat folder beside the user writable roots', async () => {
    const base = mkdtempSync(join(tmpdir(), 'orca-real-codex-visuals-'))
    try {
      const codexHome = join(base, 'codex-home')
      const cwd = join(base, 'workspace')
      const userRoot = join(base, 'user-root')
      const folder = join(base, 'state', 'chat-scratch', 'chat')
      for (const dir of [codexHome, cwd, folder]) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(
        join(codexHome, 'config.toml'),
        `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(userRoot)}]\n`
      )
      const pluginDir = join(__dirname, '..', '..', '..', 'resources', 'native-chat-visuals')
      const connection = await openCodexAppServerConnection({
        command: resolveCodexCommand(),
        args: ['app-server'],
        cwd,
        env: { HOME: base, CODEX_HOME: codexHome }
      })
      try {
        const launch = await withCodexVisualsThreadConfig(
          connection,
          {
            cwd,
            permissionPolicy: WORKSPACE_POLICY,
            visuals: { folder, skill: { pluginDir, skillsRoot: join(pluginDir, 'skills') } }
          },
          { sessionId: 'real-codex-visuals' }
        )
        const skills = JSON.stringify(
          await connection.request('skills/list', { cwds: [cwd] }, { timeoutMs: 10_000 })
        )
        expect(skills).toMatch(
          new RegExp(`"name":"(?:[a-z0-9-]+:)?${NATIVE_CHAT_VISUALS_SKILL_NAME}"`)
        )
        const opened = await connection.request(
          'thread/start',
          {
            cwd,
            ...WORKSPACE_POLICY,
            ...(launch.threadConfig ? { config: launch.threadConfig } : {})
          },
          { timeoutMs: 20_000 }
        )
        expect(opened).toMatchObject({
          sandbox: { type: 'workspaceWrite', writableRoots: [userRoot, folder] }
        })
      } finally {
        await connection.close()
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 60_000)
})

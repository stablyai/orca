import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { runProcess } from '@orca/process-host'
import {
  createCodexStructuredLaunchResolver,
  TEST_SPAWN_TOKEN
} from '../runtime/structured-agent-launch-composition.test-support'
import { readCodexCliVersion, withSupportedCodexCli } from '../codex/codex-cli-installation-error'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import { createStructuredAgentEnvironmentResolvers } from '../runtime/structured-agent-shell-environment'
import { identityFor } from '../codex/codex-structured-session-adapter-fixture'
import type * as CommandResolution from '../../shared/node-cli-command-resolution'

vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: async () => ({})
}))
vi.mock('../../shared/node-cli-command-resolution', async (original) => {
  const actual = await original<typeof CommandResolution>()
  return {
    ...actual,
    // Keep the stock resolver from substituting any real host installation.
    resolveCliCommand: (name: string) => name
  }
})

let root: string | undefined
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('workspace-relative Codex selection', () => {
  it.each(['bin', 'node_modules/.bin', '.'])(
    'admits the child selected through PATH=%s and recovers once it is updated',
    async (entry) => {
      root = await mkdtemp(join(tmpdir(), 'codex-relative-path-'))
      const cwd = root
      const directory = join(cwd, entry)
      await mkdir(directory, { recursive: true })
      const program = join(directory, 'codex')
      const versionFile = `${program}.version`
      await writeFile(versionFile, '0.136.0')
      await writeFile(
        program,
        `#!${process.execPath}\nconst fs = require('node:fs')\n` +
          `const file = __filename + '.version'\n` +
          `console.log('codex-cli ' + fs.readFileSync(file, 'utf8'))\n`,
        { mode: 0o755 }
      )
      const settings = { agentDefaultEnv: { codex: { PATH: entry } } }
      const sources = {
        resolveCommand: (options?: { pathEnv?: string | null; homePath?: string }) =>
          resolveStructuredAgentCommand('codex', settings, options),
        resolveAgentLaunchEnv: () => resolveTuiAgentLaunchEnv('codex', settings)
      }
      const environment = createStructuredAgentEnvironmentResolvers(sources)
      const record: AgentSessionRecord = {
        ...agentSessionRecordFixture(),
        provider: 'codex' as const,
        providerHandleChain: [],
        accountHome: { variable: 'CODEX_HOME' as const, path: join(cwd, 'account') },
        location: { ...agentSessionRecordFixture().location, workspaceKind: 'folder' as const }
      }
      const resolve = withSupportedCodexCli(
        createCodexStructuredLaunchResolver({
          store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
          resolveCommand: sources.resolveCommand,
          resolveEnvironment: () => environment.resolveAgentEnvironment('codex'),
          resolveLaunchArgs: () => [],
          resolveWorkspacePath: async () => cwd
        })
      )
      for (const resume of [false, true]) {
        const value = agentSessionRecordFixture()
        record.providerHandleChain = resume
          ? [{ ...value.providerHandleChain[0], handle: codexProviderHandle('thread') }]
          : []
        const launch = await resolve({
          identity: identityFor(record.sessionId),
          spawnToken: TEST_SPAWN_TOKEN
        })
        const actual = await runProcess({
          program: launch.command,
          cwd: launch.cwd,
          env: launch.env,
          args: ['--version']
        })
        expect(actual.code).toBe(0)
        expect(actual.stdout.trim()).toBe('codex-cli 0.136.0')
        await writeFile(versionFile, '0.135.0')
        await expect(
          resolve({ identity: identityFor(record.sessionId), spawnToken: TEST_SPAWN_TOKEN })
        ).rejects.toThrow('0.135.0')
        // An external update is checked again on the next chat start.
        await writeFile(versionFile, '0.136.0')
        await expect(
          resolve({ identity: identityFor(record.sessionId), spawnToken: TEST_SPAWN_TOKEN })
        ).resolves.toMatchObject({
          cwd
        })
      }
    }
  )

  it('resolves a relative command path before probing it', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-relative-command-'))
    await mkdir(join(root, 'bin'))
    const file = join(root, 'bin', 'codex')
    await writeFile(file, `#!${process.execPath}\nconsole.log('codex-cli 0.136.0')\n`, {
      mode: 0o755
    })
    const input = { program: join('bin', 'codex'), cwd: root, env: { PATH: '' } }
    expect(await readCodexCliVersion(input)).toEqual({ version: '0.136.0' })
    await writeFile(file, `#!${process.execPath}\nconsole.log('codex-cli 0.135.0')\n`, {
      mode: 0o755
    })
    expect(await readCodexCliVersion(input)).toEqual({ version: '0.135.0' })
  })
})

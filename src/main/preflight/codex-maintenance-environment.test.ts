import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { createCodexStructuredLaunchResolver } from '../codex/codex-structured-launch-resolution'
import { buildCodexStructuredChildEnvironment } from '../codex/codex-structured-child-environment'
import { identityFor } from '../codex/codex-structured-session-adapter-fixture'
import { readCodexCliInstallation } from './codex-cli-installation'
import { resolveCodexMaintenanceCommand } from './codex-maintenance-command'

vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: async () => ({})
}))
let root: string | undefined
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')(
  'pairs the forwarding wrapper runtime identically for admission, the notice check and persistent launch',
  async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-environment-'))
    const wrapperDirectory = join(root, 'wrapper')
    const supportedDirectory = join(root, 'supported')
    await Promise.all([mkdir(wrapperDirectory), mkdir(supportedDirectory)])
    const command = join(wrapperDirectory, 'company-codex')
    await writeFile(command, '#!/bin/sh\nexec codex "$@"\n')
    await chmod(command, 0o755)
    await symlink(process.execPath, join(wrapperDirectory, 'node'))
    for (const [directory, version] of [
      [wrapperDirectory, '0.135.0'],
      [supportedDirectory, '0.136.0']
    ]) {
      const file = join(directory, 'codex')
      await writeFile(file, `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`)
      await chmod(file, 0o755)
    }
    const environment = { PATH: supportedDirectory }
    const value = {
      ...agentSessionRecordFixture(),
      provider: 'codex' as const,
      providerHandleChain: [],
      accountHome: { variable: 'CODEX_HOME' as const, path: join(root, 'account') }
    }
    let admission: Awaited<ReturnType<typeof readCodexCliInstallation>> | undefined
    const resolve = createCodexStructuredLaunchResolver({
      store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
      resolveCommand: () => command,
      resolveEnvironment: async () => environment,
      resolveLaunchArgs: () => [],
      resolveWorkspacePath: async () => root ?? tmpdir(),
      requireSupportedCli: async (input) => {
        admission = await readCodexCliInstallation(input)
      }
    })
    const launch = await resolve({ identity: identityFor(value.sessionId) })
    const maintenance = await resolveCodexMaintenanceCommand({
      cwd: root,
      commandSettings: {
        agentCmdOverrides: { codex: command },
        agentDefaultEnv: { codex: environment }
      }
    })
    const child = buildCodexStructuredChildEnvironment(launch, 'token', value.sessionId)
    expect(admission).toMatchObject({ status: 'unsupported', version: '0.135.0' })
    expect(maintenance.installation).toEqual(admission)
    expect(child.PATH).toBe(launch.env?.PATH)
    expect(child.PATH?.split(delimiter)).toContain(wrapperDirectory)
    expect(child.PATH?.split(delimiter)).toContain(supportedDirectory)
  }
)

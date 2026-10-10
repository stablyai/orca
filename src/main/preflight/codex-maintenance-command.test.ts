import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../shared/codex-cli-installation'
import { resolveCodexMaintenanceCommand } from './codex-maintenance-command'

const { invocation, installation, resolve } = vi.hoisted(() => ({
  invocation: vi.fn(),
  installation: vi.fn(),
  resolve: vi.fn()
}))
vi.mock('../codex/codex-structured-launch-resolution', () => ({
  resolveCodexStructuredInvocation: invocation
}))
vi.mock('./codex-cli-installation', () => ({
  readCodexCliInstallationEvidence: async (input: unknown) => ({
    installation: await installation(input),
    expiresAt: Date.now() + 30_000,
    configurationId: 'config'
  })
}))
vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommand: resolve,
  withCliRuntimeOnPath: (_program: string, env: NodeJS.ProcessEnv) => env
}))
vi.mock('../startup/login-shell-environment', () => ({ resolveLoginShellEnvironment: vi.fn() }))
const root = join('/host', 'tools')
beforeEach(() => {
  invocation.mockResolvedValue({ command: 'codex', environment: { PATH: root } })
  resolve.mockReturnValue(join(root, 'npm'))
  installation.mockResolvedValue(codexCliInstallation(false, null))
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('Codex install command', () => {
  it('installs a missing Codex with the npm found on the chat PATH, without a shell', async () => {
    const result = await resolveCodexMaintenanceCommand({ cwd: root })
    expect(resolve).toHaveBeenCalledWith('npm', { pathEnv: root })
    expect(result.spec).toEqual({
      program: join(root, 'npm'),
      args: ['install', '-g', '@openai/codex'],
      cwd: root,
      env: { PATH: root }
    })
  })
  it.each([null, '0.135.0', '0.136.0'])(
    'offers nothing to run for an installed Codex: %s',
    async (version) => {
      installation.mockResolvedValue(codexCliInstallation(true, version))
      expect((await resolveCodexMaintenanceCommand()).spec).toBeNull()
    }
  )
  it('does not install stock Codex when the configured Command names another program', async () => {
    const result = await resolveCodexMaintenanceCommand({
      commandSettings: { agentCmdOverrides: { codex: '/company/codex' } }
    })
    expect(result.installation.status).toBe('missing')
    expect(result.spec).toBeNull()
  })
})

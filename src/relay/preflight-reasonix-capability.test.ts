import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_HOOK_REASONIX_RUNTIME_CAPABILITY } from '../shared/protocol-version'
import type { MethodHandler } from './dispatcher'
import { PreflightHandler } from './preflight-handler'

const { lookup, configRoot } = vi.hoisted(() => ({ lookup: vi.fn(), configRoot: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: lookup })
}))
vi.mock('../main/reasonix/execution-host-config', () => ({
  resolveReasonixExecutionHostConfig: configRoot
}))
vi.mock('../main/pwsh', () => ({ isPwshAvailableAsync: vi.fn() }))
vi.mock('../main/wsl', () => ({ isWslAvailableAsync: vi.fn(), listWslDistrosAsync: vi.fn() }))
vi.mock('../main/git-bash', () => ({ isGitBashAvailable: vi.fn() }))

const platform = process.platform
beforeEach(() => {
  lookup.mockReset().mockResolvedValue({ stdout: '__ORCA_AGENT_PATH__/opt/agent\n' })
  configRoot.mockReset().mockResolvedValue('/srv/reasonix')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
})
afterEach(() => Object.defineProperty(process, 'platform', { configurable: true, value: platform }))

async function detect(agents: string[]): Promise<unknown> {
  const handlers = new Map<string, MethodHandler>()
  new PreflightHandler({ onRequest: (method, handler) => handlers.set(method, handler) })
  const handler = handlers.get('preflight.detectAgents')
  if (!handler) {
    throw new Error('Preflight handler was not registered')
  }
  return handler(
    { commands: agents.map((agent) => ({ id: agent, cmd: agent })) },
    { clientId: 1, isStale: () => false }
  )
}

it('advertises Reasonix managed hooks only with an execution-host configuration root', async () => {
  await expect(detect(['codex', 'reasonix'])).resolves.toEqual({
    agents: ['codex', 'reasonix'],
    capabilities: [AGENT_HOOK_REASONIX_RUNTIME_CAPABILITY],
    reasonixConfigHome: '/srv/reasonix'
  })
})

it('keeps legacy replies unchanged and refuses capability authority on root resolution failure', async () => {
  await expect(detect(['codex'])).resolves.toEqual({ agents: ['codex'] })
  expect(configRoot).not.toHaveBeenCalled()
  configRoot.mockRejectedValue(new Error('Invalid execution-host configuration root'))
  await expect(detect(['codex', 'reasonix'])).resolves.toEqual({ agents: ['codex', 'reasonix'] })
})

it('does not advertise the POSIX managed installer on a native Windows SSH host', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  lookup.mockResolvedValue({ stdout: 'C:\\agent\\reasonix.exe\r\n' })
  await expect(detect(['reasonix'])).resolves.toEqual({ agents: ['reasonix'] })
  expect(configRoot).not.toHaveBeenCalled()
})

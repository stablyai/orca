import { describe, expect, it, vi } from 'vitest'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'

const installed = vi.hoisted(() =>
  vi.fn<(deps: StructuredAgentSessionRuntimeDeps) => Promise<void>>(async () => {})
)
vi.mock('./structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: installed
}))
vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

import { OrcaRuntimeService } from './orca-runtime'

describe('execution host structured launch settings wiring', () => {
  it('reads saved Command and Arguments from the host settings and rereads changes', async () => {
    installed.mockClear()
    const settings: Partial<GlobalSettings> = {
      agentCmdOverrides: { claude: `"${process.execPath}"`, codex: `"${process.execPath}"` },
      agentDefaultArgs: { claude: '--model "model one"', codex: '-c model_reasoning_effort=high' }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked installer only reads the store's getSettings method.
    const runtime = new OrcaRuntimeService({ getSettings: () => settings } as never)
    await runtime.ensureStructuredAgentSessionHost()
    const deps = installed.mock.calls[0]?.[0]
    expect(deps).toBeDefined()
    expect(deps?.resolveClaudeCommand?.()).toBe(process.execPath)
    expect(deps?.resolveCodexCommand?.()).toBe(process.execPath)
    expect(await deps?.resolveLaunchArgs?.('claude')).toEqual(['--model', 'model one'])
    expect(await deps?.resolveLaunchArgs?.('codex')).toEqual(['-c', 'model_reasoning_effort=high'])
    settings.agentDefaultArgs = { claude: '--model second', codex: '' }
    expect(await deps?.resolveLaunchArgs?.('claude')).toEqual(['--model', 'second'])
    expect(await deps?.resolveLaunchArgs?.('codex')).toEqual([])
    settings.agentCmdOverrides = { claude: 'wrapper --arg' }
    expect(deps?.resolveClaudeCommand?.()).toBe(resolveCliCommand('claude'))
    settings.agentCmdOverrides = { codex: '/missing/codex' }
    expect(deps?.resolveCodexCommand?.()).toBe(resolveCliCommand('codex'))
  })
})

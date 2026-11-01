import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { partialRuntimeStore } from './runtime-store-partial-fixture'

describe('execution host structured launch settings wiring', () => {
  it('reads saved Command and Arguments from the host settings and rereads changes', async () => {
    installed.mockClear()
    const settings: Partial<GlobalSettings> = {
      agentCmdOverrides: { claude: `"${process.execPath}"`, codex: `"${process.execPath}"` },
      agentDefaultArgs: { claude: '--model "model one"', codex: '-c model_reasoning_effort=high' }
    }
    const runtime = new OrcaRuntimeService(partialRuntimeStore({ getSettings: () => settings }))
    await runtime.ensureStructuredAgentSessionHost()
    const deps = installed.mock.calls[0]?.[0]
    expect(deps).toBeDefined()
    expect(deps?.resolveClaudeCommand?.()).toEqual({ command: process.execPath, prefixArgs: [] })
    expect(deps?.resolveCodexCommand?.()).toEqual({ command: process.execPath, prefixArgs: [] })
    expect(await deps?.resolveLaunchArgs?.('claude')).toEqual(['--model', 'model one'])
    expect(await deps?.resolveLaunchArgs?.('codex')).toEqual(['-c', 'model_reasoning_effort=high'])
    settings.agentDefaultArgs = { claude: '--model second', codex: '' }
    expect(await deps?.resolveLaunchArgs?.('claude')).toEqual(['--model', 'second'])
    expect(await deps?.resolveLaunchArgs?.('codex')).toEqual([])
    settings.agentDefaultArgs = { claude: '--dangerously-skip-permissions', codex: '' }
    expect(deps?.resolveAgentFullAccess?.('claude')).toBe(true)
    expect(deps?.resolveAgentFullAccess?.('codex')).toBe(false)
    // OMP lacks bypass arguments; legacy chats inherit the new-chat permission setting.
    settings.nativeChatPermissionMode = 'full-access'
    expect(deps?.resolveAgentFullAccess?.('omp')).toBe(true)
    settings.nativeChatPermissionMode = 'ask'
    expect(deps?.resolveAgentFullAccess?.('omp')).toBe(false)
    const notRunnable = expect.objectContaining({ reason: 'agentCommandNotRunnable' })
    settings.agentCmdOverrides = { claude: 'wrapper $SECRET' }
    expect(() => deps?.resolveClaudeCommand?.()).toThrow(notRunnable)
    settings.agentCmdOverrides = { codex: '/missing/codex' }
    expect(() => deps?.resolveCodexCommand?.()).toThrow(notRunnable)
    settings.agentCmdOverrides = {}
    expect(deps?.resolveClaudeCommand?.()).toEqual({
      command: resolveCliCommand('claude'),
      prefixArgs: []
    })
    expect(deps?.resolveCodexCommand?.()).toEqual({
      command: resolveCliCommand('codex'),
      prefixArgs: []
    })
  })

  // Both stock and bare saved commands must resolve in the chat child's PATH/home.
  it.skipIf(process.platform === 'win32')(
    'resolves both agents against the PATH and home the chat child will run with',
    async () => {
      installed.mockClear()
      const bin = mkdtempSync(join(tmpdir(), 'orca-chat-child-bin-'))
      for (const name of ['custom-claude', 'custom-codex', 'claude', 'codex']) {
        writeFileSync(join(bin, name), '#!/bin/sh\n')
        chmodSync(join(bin, name), 0o755)
      }
      try {
        const settings: Partial<GlobalSettings> = {
          agentCmdOverrides: { claude: 'custom-claude', codex: 'custom-codex' }
        }
        const runtime = new OrcaRuntimeService(partialRuntimeStore({ getSettings: () => settings }))
        await runtime.ensureStructuredAgentSessionHost()
        const deps = installed.mock.calls[0]?.[0]
        const childLookup = { pathEnv: bin, homePath: bin }
        expect(deps?.resolveClaudeCommand?.(childLookup)).toEqual({
          command: join(bin, 'custom-claude'),
          prefixArgs: []
        })
        expect(deps?.resolveCodexCommand?.(childLookup)).toEqual({
          command: join(bin, 'custom-codex'),
          prefixArgs: []
        })
        settings.agentCmdOverrides = {}
        expect(deps?.resolveClaudeCommand?.(childLookup)).toEqual({
          command: join(bin, 'claude'),
          prefixArgs: []
        })
        expect(deps?.resolveCodexCommand?.(childLookup)).toEqual({
          command: join(bin, 'codex'),
          prefixArgs: []
        })
      } finally {
        rmSync(bin, { recursive: true, force: true })
      }
    }
  )
})

import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as Os from 'node:os'
import { setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))
vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))

import { CodexHookService } from './hook-service'
import { CODEX_EVENTS, CODEX_EVENT_LABEL } from './codex-hook-definition'
import { readHooksJson, wrapWindowsHookCommand } from '../agent-hooks/installer-utils'
import {
  computeTrustedHash,
  getCodexExplicitHomeHookSourcePath,
  upsertHookTrustEntries
} from './config-toml-trust'

const homes = setupCodexHookHomes(homedirMock, getPathMock)

describe.skipIf(process.platform !== 'win32')('Unicode Windows hook upgrade', () => {
  it("drops an older build's encoded Orca entries and trust from a managed home, keeping user hooks", async () => {
    const home = join(homes.tmpHome, '测试 用户')
    mkdirSync(home)
    homedirMock.mockReturnValue(home)
    const runtimeHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const configPath = join(runtimeHome, 'hooks.json')
    const tomlPath = join(runtimeHome, 'config.toml')
    const scriptPath = join(home, '.orca', 'agent-hooks', 'codex-hook.cmd')
    const oldCommand = wrapWindowsHookCommand(scriptPath)
    const userHome = join(home, '.codex')
    mkdirSync(userHome)
    const userConfig = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] }
    })
    writeFileSync(join(userHome, 'hooks.json'), userConfig)
    mkdirSync(runtimeHome, { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({
        hooks: Object.fromEntries(
          CODEX_EVENTS.map((event) => [
            event,
            [{ hooks: [{ type: 'command', command: oldCommand, timeout: 10 }] }]
          ])
        )
      })
    )
    upsertHookTrustEntries(
      tomlPath,
      CODEX_EVENTS.map((event) => ({
        sourcePath: getCodexExplicitHomeHookSourcePath(configPath),
        eventLabel: CODEX_EVENT_LABEL[event],
        groupIndex: 0,
        handlerIndex: 0,
        command: oldCommand,
        timeoutSec: 10
      }))
    )
    const service = new CodexHookService()
    // Why twice: a second refresh must find nothing Orca-owned left to remove.
    for (let pass = 0; pass < 2; pass++) {
      await service.refreshRuntimeUserHooks(runtimeHome)
      const hooks = readHooksJson(configPath)?.hooks
      const trust = readFileSync(tomlPath, 'utf8')
      for (const event of CODEX_EVENTS) {
        const commands = hooks?.[event]?.flatMap((group) => group.hooks ?? []) ?? []
        expect(commands.some((hook) => hook.command?.includes('codex-hook.'))).toBe(false)
        const entry = {
          sourcePath: getCodexExplicitHomeHookSourcePath(configPath),
          eventLabel: CODEX_EVENT_LABEL[event],
          groupIndex: 0,
          handlerIndex: 0,
          command: oldCommand,
          timeoutSec: 10
        }
        expect(trust).not.toContain(computeTrustedHash(entry))
      }
      expect(
        hooks?.Stop?.some((group) => group.hooks?.some((hook) => hook.command === 'user-hook'))
      ).toBe(true)
      expect(readFileSync(join(userHome, 'hooks.json'), 'utf8')).toBe(userConfig)
    }
  })
})

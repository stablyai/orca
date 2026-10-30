import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import type { CodexAppServerInvocation } from './codex-app-server-session'

const NPM_CODEX_SHIM = 'C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd'

vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => NPM_CODEX_SHIM }))

import { buildNativeHealInvocation } from './codex-session-index-heal'
import { createCodexModelCatalogProbe } from './codex-model-catalog-probe'

// Pass the npm shim directly so spawnProcess can resolve it without cmd.exe.
describe('short-lived Codex app-server invocations on Windows', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('hands the index-heal session the shim itself', () => {
    const invocation = buildNativeHealInvocation('C:\\homes\\a', 1_000)
    expect(invocation.command).toBe(NPM_CODEX_SHIM)
    expect(invocation.cliPath).toBe(NPM_CODEX_SHIM)
    expect(invocation.args).toEqual([...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS])
  })

  it('hands the model catalog probe session the shim itself', async () => {
    const invocations: CodexAppServerInvocation[] = []
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: 'C:\\bin' }),
      resolveCommand: () => ({ command: NPM_CODEX_SHIM, prefixArgs: [] }),
      runSession: async (invocation, body) => {
        invocations.push(invocation)
        return body({
          request: async () => ({
            data: [
              {
                model: 'gpt-live',
                displayName: 'GPT Live',
                hidden: false,
                supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
                isDefault: true
              }
            ],
            nextCursor: null
          }),
          notify: () => {}
        })
      }
    })
    await probe({ variable: 'CODEX_HOME', path: 'C:\\homes\\a' })
    expect(invocations[0]?.command).toBe(NPM_CODEX_SHIM)
    expect(invocations[0]?.args).toEqual([...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS])
  })
})

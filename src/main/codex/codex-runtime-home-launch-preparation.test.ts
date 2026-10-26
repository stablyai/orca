import { beforeEach, describe, expect, it, vi } from 'vitest'

const { grantMock } = vi.hoisted(() => ({ grantMock: vi.fn() }))
vi.mock('./codex-windows-sandbox-read-grant', () => ({
  grantCodexSandboxReadOnManagedHome: grantMock
}))
vi.mock('./hook-service', () => ({
  codexHookService: { prepareRuntimeHomeForLaunch: vi.fn(async () => ({ state: 'ok' })) }
}))
vi.mock('../wsl', () => ({ getDefaultWslDistro: () => 'Ubuntu' }))
vi.mock('./codex-hook-reconcile', () => ({ reconcileCodexHooksForLaunch: vi.fn() }))

import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import { createCodexRuntimeHomeLaunchPreparation } from './codex-runtime-home-launch-preparation'

function prepareWithHome(homePath: string) {
  const runtimeHome: Pick<CodexRuntimeHomeService, 'prepareForCodexLaunchAsync'> = {
    prepareForCodexLaunchAsync: async () => homePath
  }
  return createCodexRuntimeHomeLaunchPreparation({
    getRuntimeHome: () => runtimeHome,
    getSettings: () => undefined
  })
}

beforeEach(() => {
  grantMock.mockReset()
})

describe('Codex launch preparation sandbox read grant', () => {
  it('grants on host managed homes but not on WSL homes', async () => {
    await prepareWithHome('C:\\orca\\codex-runtime-home\\home')({ runtime: 'host' })
    await prepareWithHome('/home/me/.codex')({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    expect(grantMock.mock.calls).toEqual([['C:\\orca\\codex-runtime-home\\home']])
  })
})

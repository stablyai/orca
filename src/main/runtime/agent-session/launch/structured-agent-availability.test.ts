import { expect, it, onTestFinished, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'

const { resolveEnvironment } = vi.hoisted(() => ({ resolveEnvironment: vi.fn() }))

vi.mock('../installation/structured-agent-runtime-metadata', () => ({
  STRUCTURED_AGENT_RUNTIME_METADATA: [],
  structuredAgentRuntimeMetadata: () => ({
    definition: { agent: 'codex' },
    supportsLocation: () => true,
    chatProgram: {
      resolve: (env: Record<string, string>) => ({ command: 'codex', prefixArgs: [], env }),
      installable: () => true
    }
  })
}))

vi.mock('./structured-agent-launch-support', () => ({
  observeStructuredAgentLaunch: vi.fn(),
  resolveHostStructuredAgentLaunchEnvironment: resolveEnvironment,
  structuredAgentHostAlternativeReady: vi.fn()
}))

import { structuredAgentChatProgramNeedsInstall } from './structured-agent-availability'

it('reads a quoted absolute Windows PATH entry as absolute, not as a workspace-relative one', async () => {
  const platform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  onTestFinished(() => {
    Object.defineProperty(process, 'platform', { value: platform })
  })
  resolveEnvironment.mockResolvedValue({ Path: '"C:\\Program Files\\nodejs";C:\\Windows;' })
  const settings = getDefaultSettings('C:\\Users\\user')
  const runtime = { requireStore: () => ({ getSettings: () => settings }) }

  await expect(structuredAgentChatProgramNeedsInstall('codex', runtime)).resolves.toBe(true)
})

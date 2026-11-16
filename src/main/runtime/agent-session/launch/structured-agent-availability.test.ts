import { delimiter } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { structuredAgentChatProgramNeedsInstall } from './structured-agent-availability'

const pathEntries = vi.hoisted((): { current: string[] } => ({ current: [] }))

vi.mock('./structured-agent-launch-support', () => ({
  resolveHostStructuredAgentLaunchEnvironment: async () => ({})
}))
vi.mock('../installation/structured-agent-runtime-metadata', () => ({
  structuredAgentRuntimeMetadata: (agent: string) => ({
    definition: { agent },
    supportsLocation: () => true,
    chatProgram: {
      resolve: () => ({ command: agent, env: { PATH: pathEntries.current.join(delimiter) } }),
      installable: () => true
    }
  })
}))

const runtime = { requireStore: () => ({ getSettings: () => getDefaultSettings('/home/test') }) }

describe('structuredAgentChatProgramNeedsInstall', () => {
  it('offers the install when PATH only adds an unexpanded home entry', async () => {
    pathEntries.current = ['/usr/bin', '~/.dotnet/tools']
    await expect(structuredAgentChatProgramNeedsInstall('codex', runtime)).resolves.toBe(true)
  })
})

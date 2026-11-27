import { afterEach, expect, it } from 'vitest'
import { PreflightProjectAgentDetection } from '../../../../../shared/rpc-contract/preflight/preflight-params'
import { resolveQualifiedAgentDetectionHost } from './preflight-workspace-target'

const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
})

type DetectionRuntime = Parameters<typeof resolveQualifiedAgentDetectionHost>[0]

function windowsHost(localWindowsRuntimeDefault?: {
  kind: 'wsl'
  distro: string
}): DetectionRuntime {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const runtime = {
    requireStore: () => ({
      getSettings: () => ({ localWindowsRuntimeDefault }),
      getProjects: () => [],
      getRepos: () => []
    }),
    resolveAgentDetectionHost: async () => ({ kind: 'local' as const }),
    showManagedWorktree: async () => {
      throw new Error('unused')
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only getSettings/getProjects/getRepos from this store and never calls the worktree lookups on these paths.
  return runtime as unknown as DetectionRuntime
}

it('probes the configured Windows Agent runtime for a host-scoped list, as desktop does with nothing focused', async () => {
  const params = PreflightProjectAgentDetection.parse({ configuredWindowsRuntime: true })
  await expect(
    resolveQualifiedAgentDetectionHost(windowsHost({ kind: 'wsl', distro: 'Ubuntu' }), params)
  ).resolves.toMatchObject({
    kind: 'local',
    context: { projectRuntime: { status: 'resolved', runtime: { kind: 'wsl', distro: 'Ubuntu' } } }
  })
  // Without the setting, and for callers that send no identity, the native host stays the answer.
  await expect(resolveQualifiedAgentDetectionHost(windowsHost(), params)).resolves.toEqual({
    kind: 'local'
  })
  await expect(
    resolveQualifiedAgentDetectionHost(
      windowsHost({ kind: 'wsl', distro: 'Ubuntu' }),
      PreflightProjectAgentDetection.parse({})
    )
  ).resolves.toEqual({ kind: 'local' })
})

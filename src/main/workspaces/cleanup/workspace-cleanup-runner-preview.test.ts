import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { getDefaultWorkspaceCleanupRules } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'

const { collectWorkspaces } = vi.hoisted(() => ({ collectWorkspaces: vi.fn() }))

vi.mock('./workspace-cleanup-run-evidence', () => ({
  collectWorkspaceCleanupWorkspaces: collectWorkspaces
}))
vi.mock('../space-analysis/workspace-space-analysis-snapshot', () => ({
  readWorkspaceSpaceAnalysisSnapshot: () => Promise.resolve(null)
}))

const { WorkspaceCleanupRunner } = await import('./workspace-cleanup-runner')

function createRunner(): InstanceType<typeof WorkspaceCleanupRunner> {
  const store = {
    getSettings: () => ({ workspaceCleanupPolicy: getDefaultWorkspaceCleanupRules() })
  }
  return new WorkspaceCleanupRunner({
    // SAFETY: preview only reads settings from the store and passes the runtime through to mocked evidence.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above
    store: store as unknown as RuntimeStore,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above
    runtime: {} as OrcaRuntimeService,
    historyDirectory: '/unused'
  })
}

describe('workspace cleanup runner preview', () => {
  afterEach(() => {
    collectWorkspaces.mockReset()
  })

  it('shares one evaluation between concurrent previews of the same rules', async () => {
    let finish: (value: []) => void = () => {}
    collectWorkspaces.mockReturnValue(new Promise<[]>((resolve) => (finish = resolve)))
    const runner = createRunner()

    const first = runner.preview()
    const second = runner.preview(getDefaultWorkspaceCleanupRules())
    finish([])
    await Promise.all([first, second])

    expect(collectWorkspaces).toHaveBeenCalledTimes(1)
  })
})

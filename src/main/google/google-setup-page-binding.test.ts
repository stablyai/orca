import { describe, expect, it } from 'vitest'
import { requireSetupPageInAgentWorkspace } from './google-setup-page-binding'

const runtime = {
  bots: { list: () => [{ id: 'ivy', folderWorkspaceId: 'fw-ivy' }] },
  browserCommandWorkspaceId: async ({ page }: { page: string }) =>
    ({ 'ivy-tab': 'folder:fw-ivy', 'rex-tab': 'folder:fw-rex' })[page] ?? null
} as never

describe("a setup's browser page", () => {
  it("must be one of the agent's own tabs", async () => {
    await expect(
      requireSetupPageInAgentWorkspace(runtime, 'ivy', { browserPageId: 'ivy-tab' })
    ).resolves.toBeUndefined()
    await expect(
      requireSetupPageInAgentWorkspace(runtime, 'ivy', { browserPageId: 'rex-tab' })
    ).rejects.toThrow("isn't one of this agent's tabs")
    await expect(
      requireSetupPageInAgentWorkspace(runtime, 'ivy', { browserPageId: 'gone-tab' })
    ).rejects.toThrow("isn't one of this agent's tabs")
  })
})

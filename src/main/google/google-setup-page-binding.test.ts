import { afterEach, describe, expect, it } from 'vitest'
import {
  requireSetupPageInAgentWorkspace,
  setOwnBrowserPageWorkspace
} from './google-setup-page-binding'

const runtime = { bots: { list: () => [{ id: 'ivy', folderWorkspaceId: 'fw-ivy' }] } }
const start = (browserPageId: string) => ({ action: 'start' as const, browserPageId })

describe("a setup's browser page", () => {
  afterEach(() => setOwnBrowserPageWorkspace(null))

  it("must be one of the agent's own tabs", () => {
    setOwnBrowserPageWorkspace(
      (page) => ({ 'ivy-tab': 'folder:fw-ivy', 'rex-tab': 'folder:fw-rex' })[page] ?? null
    )
    expect(() => requireSetupPageInAgentWorkspace(runtime, 'ivy', start('ivy-tab'))).not.toThrow()
    expect(() => requireSetupPageInAgentWorkspace(runtime, 'ivy', start('rex-tab'))).toThrow(
      "isn't one of this agent's tabs"
    )
    expect(() => requireSetupPageInAgentWorkspace(runtime, 'ivy', start('gone-tab'))).toThrow(
      "isn't one of this agent's tabs"
    )
  })
})

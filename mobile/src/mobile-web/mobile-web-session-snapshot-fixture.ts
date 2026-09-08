import { MobileWebRelativePathSchema } from '../../../src/shared/mobile-web/bridge-operation-contract'
import { mobileWebPageBrowserUrl } from '../../../src/shared/mobile-web/browser-url-privacy'

type RecordValue = Record<string, unknown>

// Serialized Desktop responses for mobile transport tests; host projection tests live in the root suite.
export class SessionSnapshotFixture {
  project(value: unknown, workspace: string, workspaceId: string) {
    const source = value as RecordValue
    if (source.worktree !== workspace.slice(3) || !Array.isArray(source.tabs)) {
      throw new Error('invalid snapshot fixture')
    }
    const tabs = source.tabs.map((tab: RecordValue) => {
      const base: RecordValue = {
        id: tab.id,
        type: tab.type,
        title: tab.title,
        isActive: tab.isActive === true
      }
      if (tab.type === 'terminal') {
        base.status = tab.status === 'pending-handle' ? 'pending-handle' : 'ready'
        if (tab.launchAgent) {
          base.launchAgent = tab.launchAgent
        }
        const agent = tab.agentStatus as RecordValue | undefined
        if (agent?.state) {
          base.agentStatus = Object.fromEntries(
            Object.entries(agent).filter(([key]) =>
              [
                'state',
                'stateStartedAt',
                'agentType',
                'model',
                'toolName',
                'toolInput',
                'interactivePrompt',
                'lastAssistantMessage',
                'lastAssistantMessageIsToolOutput',
                'workingMode',
                'interrupted'
              ].includes(key)
            )
          )
        }
        const provider = agent?.providerSession as RecordValue | undefined
        if (provider?.id) {
          base.nativeChatSessionId = provider.id
        }
      } else if (tab.type === 'browser') {
        Object.assign(base, {
          browserPageId: tab.browserPageId,
          url: mobileWebPageBrowserUrl(tab.url),
          loading: tab.loading === true,
          canGoBack: tab.canGoBack === true,
          canGoForward: tab.canGoForward === true
        })
      } else {
        const path = MobileWebRelativePathSchema.safeParse(tab.relativePath)
        if (path.success) {
          base.relativePath = path.data
        }
        for (const key of ['language', 'mode', 'diffSource']) {
          if (tab[key] !== undefined) {
            base[key] = tab[key]
          }
        }
        if (tab.type === 'markdown') {
          base.isDirty = tab.isDirty === true
        }
      }
      return base
    })
    return {
      workspaceId,
      publicationEpoch: source.publicationEpoch,
      snapshotVersion: source.snapshotVersion,
      workspaceTransportState:
        source.workspaceTransportState === 'unavailable' ? 'unavailable' : 'available',
      activeTabId: source.activeTabId ?? null,
      activeTabType: source.activeTabType ?? null,
      tabs,
      truncated: false
    }
  }
}

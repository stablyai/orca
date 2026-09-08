import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type {
  HostSessionMarkdownOperations,
  HostSessionMarkdownTarget
} from './host-session-markdown-operations'

/** The shell resolves the file from the tab id. A path the page cannot express (the host opened it
 * from outside the worktree) is simply absent, never a stand-in empty string. */
function bridgeTarget(target: HostSessionMarkdownTarget) {
  return {
    workspaceId: target.workspaceId,
    tabId: target.tabId,
    ...(target.relativePath ? { relativePath: target.relativePath } : {})
  }
}

export function webHostSessionMarkdownOperations(
  client: MobileWebBridgeClient
): HostSessionMarkdownOperations {
  return {
    async readTab(request) {
      const result = await client.markdown.read({
        ...bridgeTarget(request),
        tabIsDirty: request.tabIsDirty
      })
      return {
        status: 'ready',
        content: result.content,
        localContent: result.content,
        baseVersion: result.baseVersion,
        isDirty: false,
        editable: result.editable,
        stale: result.stale,
        readOnlyReason: result.readOnlyReason
      }
    },
    async saveTab(request) {
      const result = await client.markdown.save({
        ...bridgeTarget(request),
        content: request.content,
        baseVersion: request.baseVersion
      })
      return { content: result.content, baseVersion: result.baseVersion }
    },
    loadDraft(target) {
      return client.markdown.loadDraft(bridgeTarget(target))
    },
    async saveDraft(target, draft) {
      await client.markdown.saveDraft({ ...bridgeTarget(target), draft })
    }
  }
}

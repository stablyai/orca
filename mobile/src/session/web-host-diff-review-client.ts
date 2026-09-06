import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { RpcClient } from '../transport/rpc-client'
import { webHostSourceControlClient } from '../source-control/web-host-source-control-client'
import { hostedSourceControlResponse } from '../source-control/web-host-source-control-response'
import { readWebHostDiffReviewDiff } from './web-host-diff-review-diff'
import {
  readWebHostDiffReviewMetadata,
  updateWebHostDiffReviewMetadata,
  type WebHostDiffReviewMetadataCache
} from './web-host-diff-review-metadata'

export function webHostDiffReviewClient(
  bridgeClient: MobileWebBridgeClient,
  workspaceId: string
): RpcClient {
  const sourceControl = webHostSourceControlClient(bridgeClient, workspaceId)
  const metadata: WebHostDiffReviewMetadataCache = { revision: null }
  return {
    ...sourceControl,
    async sendRequest(method, input) {
      const params = isRecord(input) ? input : {}
      if (method === 'worktree.show') {
        return hostedSourceControlResponse(async () => {
          const [base, review] = await Promise.all([
            sourceControl.sendRequest(method, input),
            readWebHostDiffReviewMetadata({
              client: bridgeClient,
              workspaceId,
              cache: metadata
            })
          ])
          if (!base.ok || !isRecord(base.result) || !isRecord(base.result.worktree)) {
            throw new Error('host_error')
          }
          return { worktree: { ...base.result.worktree, ...review } }
        })
      }
      if (method === 'worktree.set') {
        return hostedSourceControlResponse(() =>
          updateWebHostDiffReviewMetadata({
            client: bridgeClient,
            workspaceId,
            cache: metadata,
            params
          })
        )
      }
      if (method === 'git.diff' || method === 'git.branchDiff') {
        return hostedSourceControlResponse(() =>
          readWebHostDiffReviewDiff({
            client: bridgeClient,
            workspaceId,
            method,
            params
          })
        )
      }
      if (method === 'session.tabs.list') {
        return hostedSourceControlResponse(async () => {
          const snapshot = await bridgeClient.sessionSnapshot({ workspaceId })
          return {
            worktree: workspaceId,
            tabs: snapshot.tabs.flatMap((tab) =>
              tab.type === 'terminal'
                ? [{ id: tab.id, title: tab.title, type: 'terminal', terminal: tab.id }]
                : []
            )
          }
        })
      }
      if (method === 'session.tabs.createTerminal') {
        return hostedSourceControlResponse(async () => {
          const created = await bridgeClient.sessionCreate({ workspaceId })
          return {
            tab: {
              id: created.tabId,
              title: 'Terminal',
              type: 'terminal',
              terminal: created.tabId
            }
          }
        })
      }
      if (method === 'terminal.send') {
        return hostedSourceControlResponse(async () => {
          const result = await bridgeClient.sourceControlReviewTerminalSend({
            workspaceId,
            tabId: requiredString(params.terminal),
            text: requiredString(params.text),
            enter: true
          })
          return { send: result }
        })
      }
      return sourceControl.sendRequest(method, input)
    }
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('invalid_request')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

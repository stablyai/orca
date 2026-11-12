import { BrowserWindow, type WebContents, type WebFrameMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { agentTokenUsageSchema } from '../../shared/telemetry-agent-token-usage-schema'
import {
  claudeProfileTranscriptDirs,
  claudeProfileTranscriptSources
} from '../claude-usage/transcript-file-discovery'
import { loadKnownUsageWorktreesByRepo } from '../usage/worktree-attribution/usage-worktree-metadata'
import { openCodeUsageAccountRoots } from '../opencode-usage/opencode-usage-account-roots'
import { isTelemetryEnabled, track } from '../telemetry/client'
import type { UsageWorktreeSource } from '../usage/worktree-attribution/usage-worktree-metadata'
import { currentWorkerEntryLayout } from '../worker-threads/worker-thread-entry-path'
import { isRendererDocumentNavigation } from '../window/renderer-document-navigation'
import { BACKEND_CONNECTION_CHANGED } from '../../shared/backend-service-contract'

export function trustsBackendRenderer(contents: WebContents): boolean {
  if (
    contents.isDestroyed() ||
    contents.getType() !== 'window' ||
    !BrowserWindow.fromWebContents(contents)
  ) {
    return false
  }
  const layout = currentWorkerEntryLayout(__dirname)
  const roots = process.env.ELECTRON_RENDERER_URL
    ? [process.env.ELECTRON_RENDERER_URL]
    : ['index.html', 'space.html', 'popout.html'].map(
        (name) => pathToFileURL(join(layout.moduleDir, '../renderer', name)).href
      )
  return roots.some((root) => isRendererDocumentNavigation(root, contents.getURL()))
}

export function createBackendDesktopCapabilities(
  store: UsageWorktreeSource
): (method: string, params: unknown) => Promise<unknown> {
  return async (method, params) => {
    if (method === 'usage.catalog') {
      await store.whenLoaded()
      const repos = store.getRepos()
      return {
        repoIds: repos.map((repo) => repo.id),
        worktreesByRepo: [...loadKnownUsageWorktreesByRepo(store, repos)]
      }
    }
    if (method === 'usage.claudeProfileDirs') {
      return claudeProfileTranscriptDirs()
    }
    if (method === 'usage.accountRoots' && params === 'claude') {
      return claudeProfileTranscriptSources()
    }
    if (method === 'usage.accountRoots' && params === 'opencode') {
      return openCodeUsageAccountRoots()
    }
    if (method === 'usage.telemetry.enabled') {
      return isTelemetryEnabled()
    }
    if (method === 'usage.telemetry.capture') {
      return track('agent_token_usage', agentTokenUsageSchema.parse(params))
    }
    throw new Error('This desktop capability is not supported.')
  }
}

export type BackendDocument = {
  contents: WebContents
  frame: WebFrameMain
  token: string
  retire(): void
}

export function notifyBackendDocuments(
  documents: ReadonlyMap<number, BackendDocument>,
  connected: boolean,
  unavailable: boolean
): void {
  for (const document of documents.values()) {
    if (!document.contents.isDestroyed() && document.contents.mainFrame === document.frame) {
      document.frame.postMessage(BACKEND_CONNECTION_CHANGED, { connected, unavailable })
    }
  }
}

export function trackBackendDocument(
  documents: Map<number, BackendDocument>,
  contents: WebContents,
  frame: WebFrameMain,
  token: string,
  retireToken: (token: string) => void
): BackendDocument {
  documents.get(contents.id)?.retire()
  const document: BackendDocument = { contents, frame, token, retire: () => {} }
  const retire = (): void => {
    if (documents.get(contents.id) !== document) {
      return
    }
    documents.delete(contents.id)
    retireToken(document.token)
    contents.off('did-frame-navigate', navigation)
    contents.off('destroyed', retire)
  }
  const navigation = (
    _event: unknown,
    _url: string,
    _httpCode: number,
    _httpStatus: string,
    mainFrame: boolean
  ): void => {
    if (mainFrame) {
      retire()
    }
  }
  document.retire = retire
  documents.set(contents.id, document)
  contents.on('did-frame-navigate', navigation)
  contents.once('destroyed', retire)
  return document
}

import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcess
} from '../../shared/agent-process-recognition'
import { isOpenCodeNativeTitle } from '../../shared/agent-detection'
import { isKnownReadyPromptPreview } from './terminal-wait-detection'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import {
  agentTitleProvesAgentPresence,
  classifyAgentTitle,
  classifyLatestAgentTitle,
  getLatestAgentCandidateTitle,
  getLatestLeafTitle,
  ptyTitleProvesAgentPresence
} from './runtime-worktree-status-projection'

const WRAPPER_RETRY_INTERVAL_MS = 150
const WRAPPER_RETRY_TIMEOUT_MS = 6_500

type RuntimeTerminalAgentPresenceDependencies = {
  getLivePty(handle: string): RuntimePtyWorktreeRecord | null
  getLiveLeaf(handle: string): RuntimeLeafRecord
  getPrimaryLeaf(ptyId: string): RuntimeLeafRecord | null
  getTrackedPty(ptyId: string): RuntimePtyWorktreeRecord | null
  getTabTitle(tabId: string): string | null
  getForegroundProcess(ptyId: string): Promise<string | null> | null
}

export type RuntimeTerminalAgentPresenceOptions = {
  retryForegroundWrappers?: boolean
  /** Foreground identity the caller already confirmed; skips the provider's cached read. */
  foregroundProcess?: string | null
}

export class RuntimeTerminalAgentPresence {
  constructor(private readonly deps: RuntimeTerminalAgentPresenceDependencies) {}

  async isRunning(
    handle: string,
    options: RuntimeTerminalAgentPresenceOptions = {}
  ): Promise<boolean> {
    try {
      const pty = this.deps.getLivePty(handle)
      if (pty) {
        return await this.isPtyRunning(pty, this.deps.getPrimaryLeaf(pty.ptyId), options)
      }
      const leaf = this.deps.getLiveLeaf(handle)
      const trackedPty = leaf.ptyId ? this.deps.getTrackedPty(leaf.ptyId) : null
      const paneTitle = getLatestLeafTitle(leaf, null)
      const paneClassification = classifyAgentTitle(paneTitle)
      if (
        trackedPty
          ? ptyTitleProvesAgentPresence(trackedPty, paneTitle, paneClassification)
          : agentTitleProvesAgentPresence(paneTitle, paneClassification)
      ) {
        return true
      }
      const tabTitle = this.deps.getTabTitle(leaf.tabId)
      const tabClassification = paneTitle === null ? classifyAgentTitle(tabTitle) : 'neutral'
      if (
        trackedPty
          ? ptyTitleProvesAgentPresence(trackedPty, tabTitle, tabClassification)
          : agentTitleProvesAgentPresence(tabTitle, tabClassification)
      ) {
        return true
      }
      const markerTitle = paneTitle ?? tabTitle
      const waitText = buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
      if (!isOpenCodeNativeTitle(markerTitle) && isKnownReadyPromptPreview(waitText)) {
        return true
      }
      if (leaf.lastAgentStatus !== null && paneTitle === null && tabTitle === null) {
        return true
      }
      if (!leaf.ptyId) {
        return false
      }
      const foreground = await this.readForegroundProcess(leaf.ptyId, options)
      if (!foreground) {
        return false
      }
      const suppressClaude =
        paneClassification === 'management' || tabClassification === 'management'
      if (suppressClaude && isExpectedAgentProcess(foreground, 'claude')) {
        return false
      }
      return await this.isRecognizedForegroundAgentProcess(
        leaf.ptyId,
        foreground,
        suppressClaude,
        options.retryForegroundWrappers !== false
      )
    } catch {
      return false
    }
  }

  private async isPtyRunning(
    pty: RuntimePtyWorktreeRecord,
    leaf: RuntimeLeafRecord | null,
    options: RuntimeTerminalAgentPresenceOptions
  ): Promise<boolean> {
    const leafTitle = leaf
      ? getLatestAgentCandidateTitle(
          { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
          { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt }
        )
      : null
    const leafClassification = classifyAgentTitle(leafTitle)
    if (ptyTitleProvesAgentPresence(pty, leafTitle, leafClassification)) {
      return true
    }
    const ptyTitle = getLatestAgentCandidateTitle(
      { title: pty.title, updatedAt: pty.titleUpdatedAt },
      { title: pty.lastOscTitle, updatedAt: pty.lastOscTitleAt }
    )
    const ptyClassification = classifyAgentTitle(ptyTitle)
    if (leafTitle === null && ptyTitleProvesAgentPresence(pty, ptyTitle, ptyClassification)) {
      return true
    }
    const managementClassification = classifyLatestAgentTitle({
      title: pty.managementTitle,
      updatedAt: pty.managementTitleAt
    })
    const markerTitle = leafTitle ?? ptyTitle
    if (isOpenCodeNativeTitle(markerTitle) && pty.launchAgent === 'opencode') {
      return true
    }
    const waitText = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
    if (!isOpenCodeNativeTitle(markerTitle) && isKnownReadyPromptPreview(waitText)) {
      return true
    }
    if (
      pty.lastAgentStatus !== null &&
      leafTitle === null &&
      ptyTitle === null &&
      managementClassification !== 'management'
    ) {
      return true
    }
    const foreground = await this.readForegroundProcess(pty.ptyId, options)
    if (!foreground) {
      return false
    }
    const suppressClaude =
      leafTitle !== null
        ? leafClassification === 'management'
        : managementClassification === 'management'
    if (suppressClaude && isExpectedAgentProcess(foreground, 'claude')) {
      return false
    }
    return await this.isRecognizedForegroundAgentProcess(
      pty.ptyId,
      foreground,
      suppressClaude,
      options.retryForegroundWrappers !== false
    )
  }

  private async readForegroundProcess(
    ptyId: string,
    options: RuntimeTerminalAgentPresenceOptions
  ): Promise<string | null> {
    if (options.foregroundProcess !== undefined) {
      return options.foregroundProcess
    }
    return await this.deps.getForegroundProcess(ptyId)
  }

  private async isRecognizedForegroundAgentProcess(
    ptyId: string,
    foregroundProcess: string,
    suppressClaude: boolean,
    retryForegroundWrappers: boolean
  ): Promise<boolean> {
    const recognized = recognizeAgentProcess(foregroundProcess)
    if (recognized) {
      return !(suppressClaude && isExpectedAgentProcess(recognized.processName, 'claude'))
    }
    if (!isAgentForegroundWrapperProcess(foregroundProcess)) {
      return false
    }
    if (!retryForegroundWrappers) {
      return false
    }
    const startedAt = Date.now()
    while (Date.now() - startedAt < WRAPPER_RETRY_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, WRAPPER_RETRY_INTERVAL_MS))
      const refreshed = await this.deps.getForegroundProcess(ptyId)
      const refreshedRecognition = recognizeAgentProcess(refreshed)
      if (refreshedRecognition) {
        return !(
          suppressClaude && isExpectedAgentProcess(refreshedRecognition.processName, 'claude')
        )
      }
      if (!refreshed || !isAgentForegroundWrapperProcess(refreshed)) {
        return false
      }
    }
    return false
  }
}

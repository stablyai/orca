import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'

const BRACKETED_PASTE_QUIET_MS = 1500

export type PtyDraftInputReadyHost = {
  subscribeToData: (ptyId: string, listener: (data: string) => void) => () => void
  readRecentOutput: (ptyId: string) => string | undefined
  subscribeToExit: (ptyId: string, listener: () => void) => () => void
}

export function waitForPtyDraftInputReady(
  host: PtyDraftInputReadyHost,
  ptyId: string,
  agent: TuiAgent,
  signal?: AbortSignal
): Promise<boolean> {
  const readySignal =
    TUI_AGENT_CONFIG[agent].draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
  return new Promise<boolean>((resolve, reject) => {
    let settled = false
    const scanner = createDraftPasteReadyScanner(readySignal)
    let quietTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    let unsubscribeData: (() => void) | null = null
    let unsubscribeExit: (() => void) | null = null
    let listenersBound = false

    const onAbort = (): void => {
      fail(new Error('request_aborted'))
    }

    const cleanup = (): void => {
      if (quietTimer) {
        clearTimeout(quietTimer)
        quietTimer = null
      }
      if (hardTimer) {
        clearTimeout(hardTimer)
        hardTimer = null
      }
      unsubscribeData?.()
      unsubscribeData = null
      unsubscribeExit?.()
      unsubscribeExit = null
      signal?.removeEventListener('abort', onAbort)
    }

    const finish = (value: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (listenersBound) {
        cleanup()
      }
      resolve(value)
    }

    const fail = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      if (listenersBound) {
        cleanup()
      }
      reject(error)
    }

    const abortIfRequested = (): boolean => {
      if (!signal?.aborted) {
        return false
      }
      onAbort()
      return true
    }

    const observeData = (data: string): void => {
      if (abortIfRequested()) {
        return
      }
      const { ready, armQuietTimer } = scanner.observe(data)
      if (ready) {
        finish(true)
        return
      }
      if (!armQuietTimer) {
        return
      }
      if (quietTimer) {
        clearTimeout(quietTimer)
      }
      quietTimer = setTimeout(() => {
        if (abortIfRequested()) {
          return
        }
        finish(true)
      }, BRACKETED_PASTE_QUIET_MS)
    }

    unsubscribeData = host.subscribeToData(ptyId, observeData)
    unsubscribeExit = host.subscribeToExit(ptyId, () => {
      if (abortIfRequested()) {
        return
      }
      fail(new Error('terminal_exited'))
    })
    if (!settled) {
      signal?.addEventListener('abort', onAbort, { once: true })
    }
    listenersBound = true
    if (settled) {
      cleanup()
      return
    }
    if (abortIfRequested()) {
      return
    }
    const replay = host.readRecentOutput(ptyId)
    if (replay) {
      observeData(replay)
    }
    if (!settled) {
      hardTimer = setTimeout(() => {
        if (abortIfRequested()) {
          return
        }
        finish(false)
      }, resolveDraftPasteReadyTimeoutMs(agent))
    }
  })
}

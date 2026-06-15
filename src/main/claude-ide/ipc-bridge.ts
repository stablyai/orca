import type { IdeBridge, Selection, OpenEditor } from './ide-tools'

export type Sender = (
  channel: string,
  payload: { worktreeId: string; requestId: string; [k: string]: unknown },
) => void

export type IpcBridge = {
  // Called by the ipcMain reply handler when the renderer reports a diff verdict.
  resolvePending(requestId: string, verdict: 'keep' | 'reject'): void
  // Called when the diff tab closes — resolves all outstanding openDiff promises
  // with 'reject' so they never hang.
  rejectAllPending(): void
  // Called by the ipcMain reply handler for all data-returning requests.
  resolveData(requestId: string, value: unknown): void
} & IdeBridge

export function createIpcBridge(worktreeId: string, send: Sender): IpcBridge {
  let seq = 0
  // Per-instance maps so multiple bridges never cross-resolve each other's requests.
  const verdictResolvers = new Map<string, (v: 'keep' | 'reject') => void>()
  const dataResolvers = new Map<string, (v: unknown) => void>()

  function nextId(): string {
    return `${worktreeId}:${seq++}`
  }

  function sendRequest(channel: string, extra: Record<string, unknown> = {}): string {
    const requestId = nextId()
    send(channel, { worktreeId, requestId, ...extra })
    return requestId
  }

  // Why: if the renderer never replies (crash, reload, dropped message) the
  // CLI's tool call must fail instead of hanging its session forever.
  const DATA_REQUEST_TIMEOUT_MS = 15_000

  function dataRequest<T>(channel: string, extra?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const requestId = sendRequest(channel, extra)
      const timer = setTimeout(() => {
        if (dataResolvers.delete(requestId)) {
          reject(new Error(`IDE request ${channel} timed out waiting for the editor`))
        }
      }, DATA_REQUEST_TIMEOUT_MS)
      dataResolvers.set(requestId, (v: unknown) => {
        clearTimeout(timer)
        resolve(v as T)
      })
    })
  }

  return {
    // openDiff blocks until the user accepts or rejects the proposed edit.
    openDiff(args) {
      return new Promise<'keep' | 'reject'>((resolve) => {
        const requestId = sendRequest('claudeIde:openDiff', args)
        verdictResolvers.set(requestId, resolve)
      })
    },

    openFile(path) {
      return dataRequest<void>('claudeIde:openFile', { path })
    },

    getWorkspaceFolders() {
      return dataRequest<string[]>('claudeIde:getWorkspaceFolders')
    },

    getCurrentSelection() {
      return dataRequest<Selection | null>('claudeIde:getCurrentSelection')
    },

    getOpenEditors() {
      return dataRequest<OpenEditor[]>('claudeIde:getOpenEditors')
    },

    checkDocumentDirty(path) {
      return dataRequest<boolean>('claudeIde:checkDocumentDirty', { path })
    },

    saveDocument(path) {
      return dataRequest<void>('claudeIde:saveDocument', { path })
    },

    resolvePending(requestId, verdict) {
      const resolve = verdictResolvers.get(requestId)
      if (resolve) {
        verdictResolvers.delete(requestId)
        resolve(verdict)
      }
    },

    rejectAllPending() {
      for (const [id, resolve] of verdictResolvers) {
        verdictResolvers.delete(id)
        resolve('reject')
      }
    },

    resolveData(requestId, value) {
      const resolve = dataResolvers.get(requestId)
      if (resolve) {
        dataResolvers.delete(requestId)
        resolve(value)
      }
    },
  }
}

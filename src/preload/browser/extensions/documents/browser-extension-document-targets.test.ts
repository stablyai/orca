import { runInNewContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  installBrowserExtensionDocumentTargets,
  PRELOAD_FIRST_DISCARDED_TAB_ID
} from './browser-extension-document-targets'

type NativeListener = (message: unknown, sender: unknown, respond: (value: unknown) => void) => void

function navigatingDocumentTarget(navigateOnLookup = 1) {
  let current = 'old-document'
  const delivered: string[] = []
  const listeners = new Set<NativeListener>()
  const runtime = {
    id: 'extension',
    getManifest: () => ({ permissions: ['webNavigation', 'scripting'] }),
    onMessage: {
      addListener: (listener: NativeListener) => listeners.add(listener),
      removeListener: (listener: NativeListener) => listeners.delete(listener)
    }
  }
  const chrome = {
    runtime,
    scripting: {
      executeScript: async (injection: {
        target: { documentIds?: string[]; tabId: number }
        func?: () => unknown
      }) => {
        if (injection.target.documentIds?.some((id) => id !== current)) {
          throw new Error('No matching document')
        }
        const result = injection.func?.()
        return [{ frameId: 0, documentId: current, result }]
      }
    },
    tabs: {
      sendMessage: async (_tabId: number, message: unknown, options?: { documentId?: string }) => {
        if (options?.documentId && options.documentId !== current) {
          throw new Error('No matching document')
        }
        if (typeof message === 'string') {
          delivered.push(current)
          return 'received'
        }
        for (const listener of listeners) {
          listener(
            {
              orcaDocumentTargetProbe: {
                ...(message &&
                typeof message === 'object' &&
                'orcaDocumentTargetProbe' in message &&
                message.orcaDocumentTargetProbe &&
                typeof message.orcaDocumentTargetProbe === 'object'
                  ? message.orcaDocumentTargetProbe
                  : {}),
                response: true
              }
            },
            { id: 'extension', tab: { id: 3 }, frameId: 0, documentId: current },
            () => {}
          )
        }
        return true
      }
    }
  }
  let lookups = 0
  const bridge = {
    call: async () => {
      const value = [{ frameId: 0, documentId: current }]
      if (++lookups === navigateOnLookup) {
        current = 'new-document'
      }
      return { ok: true as const, value }
    },
    listen: () => {},
    onEvent: () => {},
    passesFilter: () => true
  }
  const realm = { chrome, crypto: webcrypto, setTimeout, clearTimeout }
  runInNewContext(`(${installBrowserExtensionDocumentTargets.toString()})(bridge, first)`, {
    ...realm,
    globalThis: realm,
    bridge,
    first: PRELOAD_FIRST_DISCARDED_TAB_ID
  })
  return { chrome, delivered, listeners }
}

describe('Orca documentIds in native scripting targets', () => {
  it.each([1, 2])(
    'rejects script navigation at discovery snapshot %i before executing user code',
    async (snapshot) => {
      const { chrome } = navigatingDocumentTarget(snapshot)
      const userCode = vi.fn()

      await expect(
        chrome.scripting.executeScript({
          target: { documentIds: ['old-document'], tabId: 3 },
          func: userCode
        })
      ).rejects.toThrow(/document/i)

      expect(userCode).not.toHaveBeenCalled()
    }
  )

  it.each([1, 2])(
    'rejects message navigation at discovery snapshot %i before delivering the payload',
    async (snapshot) => {
      const { chrome, delivered, listeners } = navigatingDocumentTarget(snapshot)

      await expect(
        chrome.tabs.sendMessage(3, 'document-specific secret', {
          documentId: 'old-document'
        })
      ).rejects.toThrow(/document/i)

      expect(delivered).toEqual([])
      expect(listeners.size).toBe(0)
    }
  )
})

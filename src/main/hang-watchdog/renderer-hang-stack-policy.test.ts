import { expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
vi.mock('../observability', () => ({
  resolveObservabilityConsent: () => ({ localFileEnabled: true })
}))
import { installRendererHangStackPolicy } from './renderer-hang-stack-policy'

it('opts in only the owned main document and preserves unrelated response policy', () => {
  let listener: (details: unknown, callback: (value: unknown) => void) => void = () => {}
  const onHeadersReceived = vi.fn((_filter, callback) => {
    listener = callback
  })
  const contents = Object.assign(new EventEmitter(), {
    id: 4,
    session: { webRequest: { onHeadersReceived } }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this Electron test double supplies the members used by the collector; unused native members are never accessed.
  installRendererHangStackPolicy(contents as unknown as WebContents, 'file:///app/index.html')
  const answer = vi.fn()
  listener(
    {
      url: 'file:///app/index.html',
      resourceType: 'mainFrame',
      webContentsId: 4,
      responseHeaders: {
        'Content-Security-Policy': ["default-src 'self'"],
        'document-policy': ['sync-xhr=?0, include-js-call-stacks-in-crash-reports=?0']
      }
    },
    answer
  )
  expect(answer).toHaveBeenLastCalledWith({
    responseHeaders: {
      'Content-Security-Policy': ["default-src 'self'"],
      'document-policy': ['sync-xhr=?0', 'include-js-call-stacks-in-crash-reports']
    }
  })
  listener({ url: 'file:///app/index.html', resourceType: 'mainFrame', webContentsId: 9 }, answer)
  expect(answer).toHaveBeenLastCalledWith({})
  contents.emit('destroyed')
  listener({ url: 'file:///app/index.html', resourceType: 'mainFrame', webContentsId: 4 }, answer)
  expect(answer).toHaveBeenLastCalledWith({})
})

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetch } = vi.hoisted(() => ({ netFetch: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: netFetch } }))

import type { WebContents } from 'electron'
import {
  installMainDocumentCallStackPolicy,
  JS_CALL_STACK_DOCUMENT_POLICY
} from './main-document-call-stack-policy'

type Handler = (request: Request) => Promise<Response>

function fakeWebContents(alreadyHandled = false) {
  let handler: Handler | null = null
  const protocol = {
    isProtocolHandled: vi.fn(() => alreadyHandled || handler !== null),
    handle: vi.fn((_scheme: string, next: Handler) => {
      handler = next
    }),
    unhandle: vi.fn(() => {
      handler = null
    })
  }
  const emitter = Object.assign(new EventEmitter(), {
    session: { protocol },
    isDestroyed: () => false
  })
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the policy only uses the session.protocol members and events stubbed here.
    webContents: emitter as unknown as WebContents,
    protocol,
    navigate: (url: string, isMainFrame = true, isSameDocument = false) =>
      emitter.emit('did-start-navigation', { url, isMainFrame, isSameDocument }),
    stopLoading: () => emitter.emit('did-stop-loading'),
    serve: (url: string) => {
      if (!handler) {
        throw new Error('file scheme is not handled')
      }
      return handler(new Request(url))
    }
  }
}

let rendererDir: string
let documentPath: string
let documentUrl: string

describe('installMainDocumentCallStackPolicy', () => {
  beforeEach(() => {
    rendererDir = mkdtempSync(join(tmpdir(), 'orca-call-stack-policy-'))
    documentPath = join(rendererDir, 'index.html')
    documentUrl = pathToFileURL(documentPath).href
    writeFileSync(documentPath, '<html></html>')
    netFetch.mockReset()
    netFetch.mockImplementation(
      async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
    )
  })

  afterEach(() => {
    rmSync(rendererDir, { recursive: true, force: true })
  })

  it('opts each main document load into JS call stacks, then hands file:// back to Chromium', async () => {
    const { webContents, protocol, navigate, serve } = fakeWebContents()
    installMainDocumentCallStackPolicy(webContents, documentPath)

    // Initial load, then a menu/IPC/location reload: every document fetch carries the header.
    for (let load = 1; load <= 2; load += 1) {
      navigate(documentUrl)
      const response = await serve(documentUrl)
      expect(response.headers.get('Document-Policy')).toBe(JS_CALL_STACK_DOCUMENT_POLICY)
      expect(response.headers.get('content-type')).toBe('text/html')
      expect(await response.text()).toBe('<html></html>')
      expect(protocol.unhandle).toHaveBeenCalledTimes(load)
    }
    expect(netFetch).toHaveBeenCalledWith(expect.any(Request), {
      bypassCustomProtocolHandlers: true
    })
  })

  it('passes other file:// requests through untouched while armed', async () => {
    const { webContents, protocol, navigate, serve } = fakeWebContents()
    installMainDocumentCallStackPolicy(webContents, documentPath)
    navigate(documentUrl)

    const response = await serve(pathToFileURL(join(rendererDir, 'assets', 'a.js')).href)

    expect(response.headers.get('Document-Policy')).toBeNull()
    expect(protocol.unhandle).not.toHaveBeenCalled()
  })

  it('ignores subframe, same-document and other-document navigations', () => {
    const { webContents, protocol, navigate } = fakeWebContents()
    installMainDocumentCallStackPolicy(webContents, documentPath)
    navigate(documentUrl, false)
    navigate(`${documentUrl}#settings`, true, true)
    navigate(pathToFileURL(join(rendererDir, 'other.html')).href)
    navigate('https://example.com/')
    expect(protocol.handle).not.toHaveBeenCalled()
  })

  it('never replaces a file handler it did not install', () => {
    const { webContents, protocol, navigate, stopLoading } = fakeWebContents(true)
    const policy = installMainDocumentCallStackPolicy(webContents, documentPath)
    navigate(documentUrl)
    stopLoading()
    policy.dispose()
    expect(protocol.handle).not.toHaveBeenCalled()
    expect(protocol.unhandle).not.toHaveBeenCalled()
  })

  it('leaves a missing document to Chromium so the load keeps its native error code', () => {
    const { webContents, protocol, navigate } = fakeWebContents()
    rmSync(documentPath)
    installMainDocumentCallStackPolicy(webContents, documentPath)
    navigate(documentUrl)
    expect(protocol.handle).not.toHaveBeenCalled()
  })

  it('disarms when the fetch fails so later file:// requests skip the JS handler', async () => {
    const { webContents, protocol, navigate, serve } = fakeWebContents()
    installMainDocumentCallStackPolicy(webContents, documentPath)
    navigate(documentUrl)
    netFetch.mockRejectedValueOnce(new Error('net::ERR_ACCESS_DENIED'))

    await expect(serve(documentUrl)).rejects.toThrow('ERR_ACCESS_DENIED')
    expect(protocol.unhandle).toHaveBeenCalledWith('file')
    expect(protocol.isProtocolHandled()).toBe(false)
  })

  it('disarms when a navigation stops without fetching its document', () => {
    const { webContents, protocol, navigate, stopLoading } = fakeWebContents()
    installMainDocumentCallStackPolicy(webContents, documentPath)
    navigate(documentUrl)
    stopLoading()
    expect(protocol.unhandle).toHaveBeenCalledTimes(1)
    stopLoading()
    expect(protocol.unhandle).toHaveBeenCalledTimes(1)
  })

  it('stops arming and releases file:// once disposed', () => {
    const { webContents, protocol, navigate } = fakeWebContents()
    const policy = installMainDocumentCallStackPolicy(webContents, documentPath)
    navigate(documentUrl)
    policy.dispose()
    expect(protocol.unhandle).toHaveBeenCalledTimes(1)
    navigate(documentUrl)
    expect(protocol.handle).toHaveBeenCalledTimes(1)
  })

  it('matches the document path case-insensitively on Windows', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const { webContents, navigate, serve } = fakeWebContents()
      installMainDocumentCallStackPolicy(webContents, documentPath)
      const shouted = pathToFileURL(documentPath.toUpperCase()).href
      navigate(shouted)
      const response = await serve(shouted)
      expect(response.headers.get('Document-Policy')).toBe(JS_CALL_STACK_DOCUMENT_POLICY)
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })
})

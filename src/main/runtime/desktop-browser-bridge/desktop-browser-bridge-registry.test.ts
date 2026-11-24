import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DesktopBrowserBridgeEvent } from '../../../shared/browser/client-hosting/desktop-browser-bridge-protocol'
import { DesktopBrowserBridgeRegistry } from './desktop-browser-bridge-registry'

const desktop = { connectionId: 'connection-1', pairedDeviceId: 'device-1' }

function attachDesktop(registry: DesktopBrowserBridgeRegistry) {
  const events: DesktopBrowserBridgeEvent[] = []
  const { attachmentId } = registry.attach({
    ...desktop,
    capabilities: [],
    emit: (event) => events.push(event)
  })
  const lastRequest = () => {
    const request = events.findLast((event) => event.type === 'request')
    if (request?.type !== 'request') {
      throw new Error('nothing was forwarded')
    }
    return request
  }
  return { attachmentId, lastRequest }
}

describe('desktop browser bridge host files', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'orca-bridge-files-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lets the desktop read only the files the waiting upload named', async () => {
    const named = path.join(dir, 'named.txt')
    const other = path.join(dir, 'other.txt')
    await writeFile(named, 'named')
    await writeFile(other, 'other')
    const registry = new DesktopBrowserBridgeRegistry()
    const { attachmentId, lastRequest } = attachDesktop(registry)
    const forwarded = registry.forward(
      { method: 'browser.upload', params: { files: [named] }, readablePaths: [named] },
      { timeoutMs: 5_000 }
    )
    const { requestId } = lastRequest()
    const read = (caller: typeof desktop, file: string) =>
      registry.readHostFile(caller, { attachmentId, requestId, path: file, offset: 0, length: 64 })

    await expect(read(desktop, named)).resolves.toMatchObject({
      contentBase64: Buffer.from('named').toString('base64'),
      eof: true
    })
    await expect(read(desktop, other)).rejects.toThrow('desktop_browser_bridge_file_not_granted')
    await expect(read({ ...desktop, connectionId: 'connection-2' }, named)).rejects.toThrow(
      'desktop_browser_bridge_file_not_granted'
    )

    registry.settle(desktop, { attachmentId, requestId, ok: true, result: { uploaded: 1 } })
    await forwarded
    await expect(read(desktop, named)).rejects.toThrow('desktop_browser_bridge_file_not_granted')
  })

  it('saves a download only at the path the command named, before acknowledging it', async () => {
    const savePath = path.join(dir, 'out', 'saved.bin')
    const registry = new DesktopBrowserBridgeRegistry()
    const { attachmentId, lastRequest } = attachDesktop(registry)
    const forwarded = registry.forward(
      { method: 'browser.download', params: { selector: '#dl' }, downloadPath: savePath },
      { timeoutMs: 5_000 }
    )
    const { requestId, params } = lastRequest()
    expect(params).not.toHaveProperty('path')
    const transferId = String(params.transferId)
    const chunk = (offset: number, text: string, final: boolean) => ({
      attachmentId,
      transferId,
      offset,
      contentBase64: Buffer.from(text).toString('base64'),
      final
    })

    await expect(
      registry.writeDownload({ ...desktop, pairedDeviceId: 'device-2' }, chunk(0, 'x', true))
    ).rejects.toThrow('desktop_browser_bridge_attachment_unknown')
    await expect(registry.writeDownload(desktop, chunk(0, 'hello ', false))).resolves.toEqual({})
    await expect(registry.writeDownload(desktop, chunk(6, 'host', true))).resolves.toEqual({
      path: savePath
    })
    expect(await readFile(savePath, 'utf8')).toBe('hello host')

    registry.settle(desktop, { attachmentId, requestId, ok: true, result: { path: 'desktop' } })
    await expect(forwarded).resolves.toEqual({ path: savePath })
    await expect(registry.writeDownload(desktop, chunk(0, 'again', true))).rejects.toThrow(
      'desktop_browser_bridge_download_unknown'
    )
  })
})

import type { IncomingMessage } from 'node:http'
import { request } from 'node:https'
import type { OpenSpeechDownloadRequest } from './speech-model-download-response'

/**
 * Model downloads on a host without Chromium (orcad). Node does not follow redirects, so a 3xx
 * surfaces as the `redirect` Electron's `net` reports, and the download re-requests it the same
 * way. Node's `https` uses no proxy, so the host must reach the model host directly.
 */
export const openNodeSpeechDownloadRequest: OpenSpeechDownloadRequest = (url) => {
  const outgoing = request(url, { method: 'GET' })
  // Why permanent: abort() destroys the request after the download detached, and an unheard
  // ClientRequest error would crash the server.
  outgoing.on('error', () => {})
  return {
    setHeader: (name, value) => {
      outgoing.setHeader(name, value)
    },
    listen: ({ error, response, redirect }) => {
      const onResponse = (incoming: IncomingMessage): void => {
        const status = incoming.statusCode ?? 0
        const location = incoming.headers.location
        if (status >= 300 && status < 400 && location) {
          // Drained so an unread redirect body cannot hold the socket before the caller aborts.
          incoming.resume()
          redirect(status, 'GET', location)
          return
        }
        response(incoming)
      }
      outgoing.on('error', error)
      outgoing.on('response', onResponse)
      return () => {
        outgoing.off('error', error)
        outgoing.off('response', onResponse)
      }
    },
    abort: () => {
      outgoing.destroy()
    },
    end: () => {
      outgoing.end()
    }
  }
}

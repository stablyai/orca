import type { IncomingMessage } from 'node:http'
import { request } from 'node:https'
import type { OpenSpeechDownloadRequest } from './speech-model-download-response'

/** orcad uses direct Node HTTPS without proxy support; surface 3xx as redirects so the shared downloader re-requests them. */
export const openNodeSpeechDownloadRequest: OpenSpeechDownloadRequest = (url) => {
  const outgoing = request(url, { method: 'GET' })
  // Keep this after detach: abort can emit an otherwise unhandled error and crash orcad.
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
          // Drain unread redirects so their bodies cannot retain the socket before abort.
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

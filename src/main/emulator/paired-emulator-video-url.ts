import { listPairedPortForwards } from '../ports/paired-forwards/paired-port-forwards'
import { deriveAvccUrlFromStreamUrl } from './serve-sim-detached-session'

/** The H.264 URL of a paired server's simulator, through a forward this desktop runs; null for
 *  any other URL, so a pane can't point main at an arbitrary address. */
export function pairedForwardAvccUrl(streamUrl: string | undefined): string | null {
  if (!streamUrl) {
    return null
  }
  let url: URL
  try {
    url = new URL(streamUrl)
  } catch {
    return null
  }
  const port = Number(url.port)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !listPairedPortForwards().some((entry) => entry.localPort === port)
  ) {
    return null
  }
  return deriveAvccUrlFromStreamUrl(url.toString()) ?? null
}

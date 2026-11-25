import { heldByIpv4OnlyForward } from './forward-local-port-choice'
import { assertIpv6LoopbackPortFree } from './local-forward-ipv6-loopback-probe'

/** The system browser tries [::1] first for localhost. When a forward here holds the port on 127.0.0.1
 *  only and another local server answers [::1], name 127.0.0.1 so the forward gets the page. */
export async function systemBrowserUrlForForwardedLoopback(url: URL): Promise<URL> {
  const hostname = url.hostname.toLowerCase()
  if (hostname !== 'localhost' && !hostname.endsWith('.localhost')) {
    return url
  }
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  if (!heldByIpv4OnlyForward(port)) {
    return url
  }
  const ipv6Answers = await assertIpv6LoopbackPortFree(port).then(
    () => false,
    () => true
  )
  if (!ipv6Answers) {
    return url
  }
  const ipv4 = new URL(url)
  ipv4.hostname = '127.0.0.1'
  return ipv4
}

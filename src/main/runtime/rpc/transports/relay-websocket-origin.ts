// The ws(s) origin of a relay cell URL, which must be a bare http(s) origin.
export function relayWebSocketOrigin(cellUrl: string): string {
  const url = new URL(cellUrl)
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('relay_cell_url_must_be_an_origin')
  }
  if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  } else {
    throw new Error('relay_cell_url_must_use_http')
  }
  return url.origin
}

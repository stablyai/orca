export function controlWebSocketUrl(cellUrl: string): { origin: string; url: string } {
  const parsed = new URL(cellUrl)
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('relay_cell_url_must_be_an_origin')
  }
  const origin = parsed.origin
  if (parsed.protocol === 'https:') {
    parsed.protocol = 'wss:'
  } else if (parsed.protocol === 'http:') {
    parsed.protocol = 'ws:'
  } else {
    throw new Error('relay_cell_url_must_use_http')
  }
  return { origin, url: `${parsed.origin}/v1/host/control` }
}

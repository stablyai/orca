export function hostEndpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    if (!url.hostname) {
      return 'Unknown endpoint'
    }
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`
  } catch {
    return 'Unknown endpoint'
  }
}

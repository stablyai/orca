const METADATA_ROOT =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default'

async function metadataText(path: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(`${METADATA_ROOT}/${path}`, {
    headers: { 'Metadata-Flavor': 'Google' }
  })
  if (!response.ok) throw new Error(`metadata request failed: ${response.status}`)
  return await response.text()
}

export async function metadataAccessToken(fetcher: typeof fetch = fetch): Promise<string> {
  const body = JSON.parse(await metadataText('token', fetcher)) as {
    access_token?: unknown
  }
  if (typeof body.access_token !== 'string' || body.access_token.length < 20) {
    throw new Error('metadata access token is missing')
  }
  return body.access_token
}

export async function metadataServiceAccountEmail(
  fetcher: typeof fetch = fetch
): Promise<string> {
  const email = (await metadataText('email', fetcher)).trim()
  if (!/^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/.test(email)) {
    throw new Error('metadata service account email is invalid')
  }
  return email
}

export async function metadataIdentityToken(
  audience: string,
  fetcher: typeof fetch = fetch
): Promise<string> {
  const token = await metadataText(
    `identity?audience=${encodeURIComponent(audience)}&format=full`,
    fetcher
  )
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('metadata identity token is invalid')
  }
  return token
}

import { requireFilesystemHostReadClient } from '../filesystem-host/filesystem-host-read-client'

export async function extractOAuthClientCredentials(): Promise<{
  clientId: string
  clientSecret: string
} | null> {
  const client = requireFilesystemHostReadClient()
  if (!client.discoverGeminiOAuth) {
    throw new Error('Gemini discovery is unavailable')
  }
  return client.discoverGeminiOAuth()
}

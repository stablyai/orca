import { Buffer } from 'node:buffer'

type AzureDevOpsCredentials = {
  headers: Record<string, string>
  credentialAvailable: boolean
}

export async function resolveAzureDevOpsCredentials(): Promise<AzureDevOpsCredentials> {
  const accessToken = process.env.ORCA_AZURE_DEVOPS_ACCESS_TOKEN?.trim()
  if (accessToken) {
    return { headers: { Authorization: `Bearer ${accessToken}` }, credentialAvailable: true }
  }

  const pat =
    process.env.ORCA_AZURE_DEVOPS_TOKEN?.trim() || process.env.ORCA_AZURE_DEVOPS_PAT?.trim()
  if (pat) {
    const username = process.env.ORCA_AZURE_DEVOPS_USERNAME?.trim() ?? ''
    const encoded = Buffer.from(`${username}:${pat}`).toString('base64')
    return { headers: { Authorization: `Basic ${encoded}` }, credentialAvailable: true }
  }

  return { headers: {}, credentialAvailable: false }
}

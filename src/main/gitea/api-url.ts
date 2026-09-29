import { cleanCloudServiceUrl } from '../../shared/cloud-service-url'

export function validateGiteaApiUrl(value: string): string {
  const cleaned = cleanCloudServiceUrl(value, true)
  if (!cleaned) {
    throw new Error('Gitea server URLs must use HTTPS (HTTP is allowed only on localhost).')
  }
  const url = new URL(cleaned)
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Enter a Gitea server URL without credentials, query parameters, or fragments.')
  }
  return cleaned.replace(/\/+$/, '')
}

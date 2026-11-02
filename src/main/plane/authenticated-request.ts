export class PlaneApiError extends Error {
  readonly status: number
  readonly data: unknown

  constructor(message: string, status: number, data?: unknown) {
    super(message)
    this.name = 'PlaneApiError'
    this.status = status
    this.data = data
  }
}

export function normalizePlaneBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Instance URL cannot be empty')
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return withProtocol.replace(/\/+$/, '')
}

export async function planeRequest<T>(
  instanceUrl: string,
  apiToken: string,
  endpoint: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
    body?: unknown
    params?: Record<string, string | number | boolean | undefined>
  } = {}
): Promise<T> {
  const baseUrl = normalizePlaneBaseUrl(instanceUrl)
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
  const url = new URL(`${baseUrl}${cleanEndpoint}`)

  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value))
      }
    }
  }

  const headers: Record<string, string> = {
    'X-API-Key': apiToken,
    Accept: 'application/json'
  }

  let bodyString: string | undefined
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    bodyString = JSON.stringify(options.body)
  }

  const response = await fetch(url.toString(), {
    method: options.method ?? 'GET',
    headers,
    body: bodyString
  })

  if (!response.ok) {
    let errorDetail = `Request failed with status ${response.status}`
    let errorJson: unknown
    try {
      errorJson = await response.json()
      if (errorJson && typeof errorJson === 'object') {
        const errorRecord = errorJson as Record<string, unknown>
        if (typeof errorRecord.error === 'string') {
          errorDetail = errorRecord.error
        } else if (typeof errorRecord.message === 'string') {
          errorDetail = errorRecord.message
        } else if (typeof errorRecord.detail === 'string') {
          errorDetail = errorRecord.detail
        }
      }
    } catch {
      // Non-JSON response
    }
    throw new PlaneApiError(errorDetail, response.status, errorJson)
  }

  if (response.status === 204) {
    return {} as T
  }

  return (await response.json()) as T
}

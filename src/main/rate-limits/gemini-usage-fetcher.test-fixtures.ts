export function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  } as Response
}

export function makeDirent(name: string, isDir: boolean) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir
  }
}

export const authJsonGoogle = {
  google: {
    type: 'oauth',
    access: 'auth-json-access-token',
    expires: new Date('2026-04-24T13:00:00.000Z').getTime(),
    refresh: 'refresh-token-abc|proj-123|managed-456'
  }
} as const

export const authJsonGoogleExpired = {
  google: {
    type: 'oauth',
    access: 'expired-access-token',
    expires: new Date('2026-04-24T11:00:00.000Z').getTime(),
    refresh: 'refresh-token-abc|proj-123|managed-456'
  }
} as const

export const validCreds = {
  access_token: 'valid-token',
  refresh_token: 'refresh-token',
  expiry_date: new Date('2026-04-24T13:00:00.000Z').getTime()
}

export const expiredCreds = {
  access_token: 'expired-token',
  refresh_token: 'refresh-token',
  expiry_date: new Date('2026-04-24T11:00:00.000Z').getTime()
}

export const oauth2JsContent = `
  const OAUTH_CLIENT_ID = 'client-id-123';
  const OAUTH_CLIENT_SECRET = 'client-secret-456';
`

export const quotaResponse = [
  { remainingFraction: 0.75, resetTime: '2026-04-24T13:00:00.000Z', modelId: 'gemini-2.5-pro' },
  { remainingFraction: 0.9, resetTime: '2026-04-24T14:00:00.000Z', modelId: 'gemini-2.5-flash' }
]

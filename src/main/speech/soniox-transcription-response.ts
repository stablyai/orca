export type SonioxToken = {
  text?: unknown
  is_final?: unknown
}

export type SonioxResponse = {
  tokens?: unknown
  finished?: unknown
  error_type?: unknown
  error_message?: unknown
  error_code?: unknown
  request_id?: unknown
}

export function isSonioxControlToken(token: SonioxToken): boolean {
  return token.text === '<end>' || token.text === '<fin>'
}

export function parseSonioxResponse(data: unknown): SonioxResponse {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
  try {
    return JSON.parse(text) as SonioxResponse
  } catch {
    throw new Error('Soniox transcription returned an invalid response')
  }
}

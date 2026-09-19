import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js'

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone'
export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions'
export const DEFAULT_MODEL = 'jev-latest'
export const OPENROUTER_DEFAULT_MODEL = 'typesafe/jev-1.13'

export type JevRequest = {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey: string
    model?: string
    baseUrl?: string
  },
  state: JevState,
  questions: JevQuestions
): JevRequest {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions
    })
  }
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(status: number, ok: boolean, text: string): JevResponse {
  if (!ok) {
    let errorDetail = text.slice(0, 200)
    try {
      const errObj = JSON.parse(text)
      if (errObj?.error?.message) {
        errorDetail = errObj.error.message
      }
    } catch {
      // ignore
    }
    throw new Error(`Jev request failed (${status}): ${errorDetail}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Jev returned malformed JSON')
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers')
  }
  return parsed as JevResponse
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(answers: Record<string, JevAnswer>, name: string): number {
  const answer = answers[name]
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`)
  }
  return answer.noul
}

import type { ScryerExecutorFailure } from './types'

export type SelectorResult<TResult> =
  | { ok: true; result: TResult }
  | { ok: false; failure: ScryerExecutorFailure }

export function invalidInput(path: string, message: string): SelectorResult<never> {
  return {
    ok: false,
    failure: {
      code: 'invalid_input',
      message,
      fieldErrors: [{ path, message }]
    }
  }
}

export function nodeNotFound(id: string, field = 'node'): SelectorResult<never> {
  return {
    ok: false,
    failure: {
      code: 'not_found',
      message: `Scryer node '${id}' was not found`,
      details: { entity: 'node', id, field }
    }
  }
}

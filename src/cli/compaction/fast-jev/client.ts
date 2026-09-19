import {
  buildJevRequest,
  DEFAULT_MODEL,
  OPENROUTER_DECISIONS_URL,
  OPENROUTER_DEFAULT_MODEL,
  parseJevResponse,
  SYSTEM_ONE_URL
} from './request.js'
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js'

export type JevClientOptions = {
  /** Defaults to `process.env.OPENROUTER_API_KEY` or `process.env.TYPESAFE_API_KEY`. */
  apiKey?: string
  /** Defaults to `typesafe/jev-1.13` (OpenRouter) or `jev-latest` (TypeSafe). */
  model?: string
  /** Defaults to the OpenRouter or System One endpoint. */
  baseUrl?: string
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string
  private readonly model: string | undefined
  private readonly baseUrl: string | undefined
  private readonly fetcher: typeof fetch

  constructor(options: JevClientOptions = {}) {
    const openRouterKey = options.apiKey ?? process.env.OPENROUTER_API_KEY
    const typeSafeKey = options.apiKey ?? process.env.TYPESAFE_API_KEY
    const resolvedKey = openRouterKey || typeSafeKey || ''
    this.apiKey = resolvedKey

    const isOpenRouter = Boolean(
      options.baseUrl?.includes('openrouter.ai') ||
      (!options.baseUrl &&
        (Boolean(process.env.OPENROUTER_API_KEY) || resolvedKey.startsWith('sk-or-')))
    )

    if (isOpenRouter) {
      this.baseUrl = options.baseUrl ?? OPENROUTER_DECISIONS_URL
      this.model = options.model ?? OPENROUTER_DEFAULT_MODEL
    } else {
      this.baseUrl = options.baseUrl ?? SYSTEM_ONE_URL
      this.model = options.model ?? DEFAULT_MODEL
    }

    this.fetcher = options.fetch ?? fetch
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey)
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) {
      throw new Error('Neither OPENROUTER_API_KEY nor TYPESAFE_API_KEY is configured')
    }
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions
    )
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body
    })
    return parseJevResponse(response.status, response.ok, await response.text())
  }
}

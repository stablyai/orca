import type { LinearClient, LinearClientOptions, LinearError } from '@linear/sdk'
import { createRequire } from 'node:module'
import { recoverLinearQuery } from './linear-request-recovery'

// Keep a structural loader type without import-type expressions or eager SDK initialization.
export type LinearSdkModule = {
  LinearClient: new (options: LinearClientOptions) => LinearClient
  AuthenticationLinearError: new (...args: never[]) => Error
  parseLinearError: (error: unknown) => Error
  LinearError: new (...args: never[]) => LinearError
}

// Lazy synchronous loading keeps SDK parsing off startup; a separate module lets tests mock createRequire access.
const requireFromMain = createRequire(__filename)
let cached: LinearSdkModule | null = null

export function loadLinearSdk(): LinearSdkModule {
  // SAFETY: the pinned SDK exports the constructors described by its own declarations.
  cached ??= requireFromMain('@linear/sdk') as LinearSdkModule
  return cached
}

// reauthorize: a login whose token Linear refused gets one new Authorization value, or null.
export type LinearClientCreateOptions = LinearClientOptions & {
  reauthorize?: () => Promise<string | null>
}

function isAuthFailure(error: unknown): boolean {
  const sdk = loadLinearSdk()
  return sdk.parseLinearError(error) instanceof sdk.AuthenticationLinearError
}

export function createLinearClient({
  reauthorize,
  ...options
}: LinearClientCreateOptions): LinearClient {
  const client = new (loadLinearSdk().LinearClient)(options)
  const requestOptions = client.options
  // A token that expired (say, while the Mac slept) is refreshed and the call tried once more.
  const withLogin = <T>(run: () => Promise<T>) =>
    reauthorize
      ? async (): Promise<T> => {
          try {
            return await run()
          } catch (error) {
            const authorization = isAuthFailure(error) ? await reauthorize() : null
            if (authorization === null) {
              throw error
            }
            client.client.setHeader('Authorization', authorization)
            return await run()
          }
        }
      : run
  const request = client.client.request.bind(client.client)
  const rawRequest = client.client.rawRequest.bind(client.client)
  client.client.request = <Data, Variables extends Record<string, unknown>>(
    query: string,
    variables?: Variables,
    headers?: RequestInit['headers']
  ): Promise<Data> =>
    recoverLinearQuery(
      query,
      withLogin(() => request<Data, Variables>(query, variables, headers)),
      requestOptions
    )
  client.client.rawRequest = <Data, Variables extends Record<string, unknown>>(
    query: string,
    variables?: Variables,
    headers?: RequestInit['headers']
  ) =>
    recoverLinearQuery(
      query,
      withLogin(() => rawRequest<Data, Variables>(query, variables, headers)),
      requestOptions
    )
  return client
}

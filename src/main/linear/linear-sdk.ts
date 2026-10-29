import type { LinearClient, LinearClientOptions } from '@linear/sdk'
import { createRequire } from 'node:module'
import { recoverLinearQuery } from './linear-request-recovery'

// Keep a structural loader type without import-type expressions or eager SDK initialization.
export type LinearSdkModule = {
  LinearClient: new (options: LinearClientOptions) => LinearClient
  AuthenticationLinearError: new (...args: never[]) => Error
}

// Lazy synchronous loading keeps SDK parsing off startup; a separate module lets tests mock createRequire access.
const requireFromMain = createRequire(__filename)
let cached: LinearSdkModule | null = null

export function loadLinearSdk(): LinearSdkModule {
  // SAFETY: the pinned SDK exports the constructors described by its own declarations.
  cached ??= requireFromMain('@linear/sdk') as LinearSdkModule
  return cached
}

export function createLinearClient(options: LinearClientOptions): LinearClient {
  const client = new (loadLinearSdk().LinearClient)(options)
  const requestOptions = client.options
  const request = client.client.request.bind(client.client)
  const rawRequest = client.client.rawRequest.bind(client.client)
  client.client.request = <Data, Variables extends Record<string, unknown>>(
    query: string,
    variables?: Variables,
    headers?: RequestInit['headers']
  ): Promise<Data> =>
    recoverLinearQuery(
      query,
      () => request<Data, Variables>(query, variables, headers),
      requestOptions
    )
  client.client.rawRequest = <Data, Variables extends Record<string, unknown>>(
    query: string,
    variables?: Variables,
    headers?: RequestInit['headers']
  ) =>
    recoverLinearQuery(
      query,
      () => rawRequest<Data, Variables>(query, variables, headers),
      requestOptions
    )
  return client
}

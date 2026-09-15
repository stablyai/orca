import { gitStatusHostPayloadRead } from './mobile-git-read-operations'

/**
 * What a source-control operation needs to send with.
 *
 * Derived from an operation rather than restated, so accepting a client does not require a module
 * to name the raw request port. It stays exactly as narrow as the `Pick<RpcClient, 'sendRequest'>`
 * it replaces — widening it to `RpcClient` would make every unit test build a whole client.
 */
export type MobileSourceControlRpcSender = Parameters<typeof gitStatusHostPayloadRead.request>[0]

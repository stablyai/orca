import { settingsRead } from './settings-read-operations'

// Derive the operation’s sender without exposing the raw port or requiring a complete RpcClient in tests.
export type RpcOperationSender = Parameters<typeof settingsRead.request>[0]

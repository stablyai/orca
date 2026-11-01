// Import types only: parsing the host’s coercing schemas on mobile would change outgoing bytes.
// RpcSendParams describes wire input; RpcParams describes handler output after parsing.
export type {
  RpcMethodName,
  RpcParams
} from '../../../src/shared/rpc-contract/rpc-params-catalog.generated'
export type { RpcSendParams } from '../../../src/shared/rpc-contract/rpc-send-params'

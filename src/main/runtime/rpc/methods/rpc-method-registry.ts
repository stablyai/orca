import { EAGER_CORE_RPC_METHODS, EAGER_SERVICE_RPC_METHODS } from './eager-rpc-method-registry'
import { BOT_RPC_METHODS } from './bot-rpc-methods'
import { CONNECTOR_METHODS } from './connectors/connector'
import { CONNECTOR_SLACK_MIRROR_METHODS } from './connectors/connector-slack-mirror'
import { GOOGLE_METHODS } from './google'
import { GOOGLE_READ_METHODS } from './google-read'
import { GOOGLE_FILES_METHODS } from './google-files'
import { GOOGLE_WRITE_METHODS } from './google-write'
import { SPEECH_METHODS } from './speech/speech'
import { EMULATOR_METHODS } from './emulator/emulator'

const CORE_RPC_METHODS = [
  ...EAGER_CORE_RPC_METHODS,
  ...CONNECTOR_METHODS,
  ...CONNECTOR_SLACK_MIRROR_METHODS
] as const

const SERVICE_RPC_METHODS = [
  ...EAGER_SERVICE_RPC_METHODS,
  ...GOOGLE_METHODS,
  ...GOOGLE_READ_METHODS,
  ...GOOGLE_FILES_METHODS,
  ...GOOGLE_WRITE_METHODS,
  ...SPEECH_METHODS,
  ...EMULATOR_METHODS
] as const

type ConcatMethods<A extends readonly unknown[], B extends readonly unknown[]> = readonly [
  ...A,
  ...B
]

// Named segments keep declaration serialization bounded without erasing method params.
export const ALL_RPC_METHODS: ConcatMethods<
  ConcatMethods<typeof CORE_RPC_METHODS, typeof BOT_RPC_METHODS>,
  typeof SERVICE_RPC_METHODS
> = [...CORE_RPC_METHODS, ...BOT_RPC_METHODS, ...SERVICE_RPC_METHODS] as const

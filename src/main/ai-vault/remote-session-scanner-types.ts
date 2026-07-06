import type { AiVaultAgent, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { IFilesystemProvider } from '../providers/types'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { FileWithMtime } from './session-scanner-types'

export type RemoteScannerContext = {
  provider: IFilesystemProvider
  executionHostId: ExecutionHostId
  hostPlatform: RemoteHostPlatform
  titleCaches: Map<string, Promise<Map<string, string>>>
}

export type RemoteParserOptions = {
  executionHostId: ExecutionHostId
  executionHostPlatform: NodeJS.Platform
}

export type RemoteSessionSource = {
  agent: AiVaultAgent
  rootDir: string
  extensions: readonly string[]
  filePredicate?: (path: string) => boolean
  parse: (
    file: FileWithMtime,
    content: string,
    context: RemoteScannerContext
  ) => Promise<AiVaultSession | null>
}

export type RemoteSessionCandidate = {
  source: RemoteSessionSource
  file: FileWithMtime
}

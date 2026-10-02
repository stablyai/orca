import type { HarnessConversationDriverSink } from './driver'

export type AcpDriverOptions = {
  agent: 'grok'
  cwd: string
  providerSessionId: string | null
  forkFromProviderSessionId: string | null
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  sink: HarnessConversationDriverSink
}

import type { claudeInitialization } from './structured/claude-structured-startup-settled-test-support'
import type {
  ClaudeStreamJsonConnection,
  ClaudeStreamJsonLaunch,
  ClaudeStreamJsonConnectionHandlers
} from './claude-stream-json-connection'

export type FakeConnection = Omit<ClaudeStreamJsonConnection, 'closed' | 'exitVerdict'> & {
  closed: boolean
  exitVerdict: ClaudeStreamJsonConnection['exitVerdict']
  launch: ClaudeStreamJsonLaunch
  handlers: ClaudeStreamJsonConnectionHandlers
  calls: { subtype: string; params?: Record<string, unknown> }[]
  sent: Record<string, unknown>[]
  closeCount: number
  initialization: ReturnType<typeof claudeInitialization>
}

import { describe, expect, it } from 'vitest'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  PROVIDER_SESSION_ID,
  fakeClaude,
  identityFor,
  recordingJournalSink,
  claudeStartupSettled
} from './claude-structured-session-test-support'

const SESSION = 'session-1'
const ACCOUNT_HOME = '/accounts/claude'
const EFFORTS = ['low', 'medium', 'high']

const CATALOG = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Default (recommended)',
    supportsEffort: true,
    supportedEffortLevels: EFFORTS
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus',
    supportsEffort: true,
    supportedEffortLevels: EFFORTS
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: EFFORTS
  }
]

/** The user's settings pick Sonnet over the listing's recommended Opus; the CLI applies Sonnet.
 *  `listing` is what the start's settings readback hands the host; `read` is a later options read. */
async function startedChat(
  options?: Record<string, string>,
  applied: string | null = 'claude-sonnet-5'
) {
  const events: ClaudeStructuredSessionEvent[] = []
  const claude = fakeClaude({
    initProof: 'session-start',
    initModel: applied ?? 'claude-opus-5-5',
    initModels: CATALOG,
    settings: {
      effective: {},
      sources: [],
      applied: { model: applied, effort: applied ? 'high' : null, advisor: null, ultracode: false }
    },
    routes: { list_models: () => CATALOG }
  })
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: options?.model ? { model: options.model } : {},
      cwd: '/work/repo',
      claudeConfigDir: ACCOUNT_HOME,
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    persistHandle: async () => {},
    onEvent: (event) => events.push(event)
  })
  await adapter.acquire({
    identity: identityFor(SESSION),
    fence: 7,
    spawnToken: 'spawn-9',
    events: recordingJournalSink(),
    ...(options ? { options } : {})
  })
  await claudeStartupSettled(adapter, SESSION)
  const reported = events.find((event) => event.type === 'options-reported')
  return {
    listing: reported && 'catalogListing' in reported ? reported.catalogListing : undefined,
    read: async () => (await adapter.readOptions({ sessionId: SESSION, fence: 7 })).catalogListing
  }
}

async function liveListing(options?: Record<string, string>, applied?: string | null) {
  return (await startedChat(options, applied)).listing
}

describe('Claude process configuration metadata', () => {
  it('reports configured intent separately from row defaults', async () => {
    const listing = await liveListing()
    expect(listing?.configuredDefault).toEqual({ modelId: 'sonnet', effort: 'high' })
    expect(listing?.models.some((model) => model.defaultEffort !== undefined)).toBe(false)
  })

  it('reports no configured model when settings resolve none', async () => {
    expect((await liveListing(undefined, null))?.configuredDefault).toBeNull()
  })

  it('does not report a launch pick or a later runtime read as configured intent', async () => {
    expect((await liveListing({ model: 'sonnet' }))?.configuredDefault).toBeUndefined()
    const first = await startedChat()
    expect(await first.read()).not.toHaveProperty('configuredDefault')
  })
})

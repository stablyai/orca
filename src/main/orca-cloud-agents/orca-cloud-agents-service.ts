// The one-time Orca Cloud agent setup on this computer (spec §5 S0). Holds each agent's setup step,
// runs Claude's setup-token or the Codex broker, and stores the result in the Orca account. Replies
// and broadcasts carry states and codes only: no token, no CLI output, no server message.
import {
  CLAUDE_SETUP_TOKEN_PATTERN,
  IDLE_ORCA_CLOUD_AGENT_SETUPS,
  type AgentCredentialsView,
  type AgentSource,
  type AgentSourcesView,
  type OrcaCloudAccountAgent,
  type OrcaCloudAgentSetup,
  type OrcaCloudAgentSetups,
  type OrcaCloudAgentsResult,
  type OrcaCloudAgentsStatus
} from '../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  agentCredentialsFailureCode,
  type AgentCredentialsClient
} from './agent-credentials-client'
import { runClaudeSetupToken, type SpawnSetupToken } from './claude-setup-token-runner'
import {
  isCodexSignInUrl,
  startCodexBrokerSession,
  type CodexBrokerSession
} from './codex-broker-driver'

export type OrcaCloudAgentsServiceDeps = {
  client: AgentCredentialsClient | null
  spawnSetupToken: SpawnSetupToken
  /** The Claude account signed in on this computer, used as the stored credential's label. */
  readClaudeEmail: () => string | null
  openExternal: (url: string) => Promise<void>
  broadcast: (setups: OrcaCloudAgentSetups) => void
  /**
   * Who is signed in to Orca (null when signed out). A setup belongs to the identity it started
   * under: if that changes, its result is dropped instead of landing in another Orca account.
   */
  identity?: () => string | null
  now?: () => number
  codexPollMs?: number
}

export type OrcaCloudAgentsService = ReturnType<typeof createOrcaCloudAgentsService>

const CLAUDE_REOPEN_HOSTS = new Set(['claude.ai', 'claude.com', 'console.anthropic.com'])

/** Only the provider's own sign-in pages ever open from here. */
export function isProviderSignInUrl(agent: OrcaCloudAccountAgent, value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return false
  }
  if (agent === 'claude') {
    return CLAUDE_REOPEN_HOSTS.has(url.hostname)
  }
  return isCodexSignInUrl(value)
}

export function createOrcaCloudAgentsService(deps: OrcaCloudAgentsServiceDeps) {
  const now = deps.now ?? Date.now
  let setups: OrcaCloudAgentSetups = { ...IDLE_ORCA_CLOUD_AGENT_SETUPS }
  let claudeRun: AbortController | null = null
  let claudeUrl: string | null = null
  let codexSession: CodexBrokerSession | null = null
  let codexRun: { live: boolean } | null = null
  // A captured or pasted token is being stored: it can't be cancelled or raced by another one.
  let claudeSaving = false
  const identity = deps.identity ?? (() => null)
  let setupsIdentity = identity()

  const update = (agent: OrcaCloudAccountAgent, setup: OrcaCloudAgentSetup): void => {
    setups = { ...setups, [agent]: setup }
    try {
      deps.broadcast(setups)
    } catch {
      // A closing window must not break the setup itself.
    }
  }

  function stopClaudeRun(): void {
    claudeRun?.abort()
    claudeRun = null
    claudeUrl = null
  }

  function stopCodexRun(): CodexBrokerSession | null {
    const session = codexSession
    codexSession = null
    if (codexRun) {
      codexRun.live = false
      codexRun = null
    }
    return session
  }

  /** Signing out or switching Orca accounts ends any setup that started under the old one. */
  function followIdentity(): void {
    const current = identity()
    if (current === setupsIdentity) {
      return
    }
    setupsIdentity = current
    stopClaudeRun()
    void stopCodexRun()?.cancel()
    if (!claudeSaving) {
      update('claude', { phase: 'idle' })
    }
    update('codex', { phase: 'idle' })
  }

  async function attempt<T>(
    run: (client: AgentCredentialsClient) => Promise<T>
  ): Promise<OrcaCloudAgentsResult<T>> {
    if (!deps.client) {
      return { ok: false, error: 'not_configured' }
    }
    try {
      return { ok: true, value: await run(deps.client) }
    } catch (error) {
      const code = agentCredentialsFailureCode(error)
      // The code only: a message could quote a request.
      console.warn(`[orca-cloud-agents] request failed: ${code}`)
      return { ok: false, error: code }
    }
  }

  /** Stores a Claude token in the Orca account; the token goes out once and is dropped here. */
  async function storeClaude(
    token: string,
    label: string | null,
    owner: string | null
  ): Promise<OrcaCloudAgentsResult<true>> {
    if (identity() !== owner) {
      update('claude', { phase: 'failed', error: 'signed_out' })
      return { ok: false, error: 'signed_out' }
    }
    claudeSaving = true
    update('claude', { phase: 'saving' })
    const result = await attempt(async (client) => {
      await client.putClaude(token, label ?? undefined)
      return true as const
    })
    claudeSaving = false
    update('claude', result.ok ? { phase: 'saved' } : { phase: 'failed', error: result.error })
    return result
  }

  function startClaude(): void {
    if (claudeRun || claudeSaving) {
      return
    }
    const owner = identity()
    const controller = new AbortController()
    claudeRun = controller
    claudeUrl = null
    const startedAt = now()
    update('claude', { phase: 'browser', startedAt, canReopen: false })
    void runClaudeSetupToken({
      spawn: deps.spawnSetupToken,
      signal: controller.signal,
      onAuthorizeUrl: (url) => {
        if (claudeRun === controller && isProviderSignInUrl('claude', url)) {
          claudeUrl = url
          update('claude', { phase: 'browser', startedAt, canReopen: true })
        }
      }
    }).then(async (outcome) => {
      if (claudeRun !== controller) {
        return
      }
      claudeRun = null
      claudeUrl = null
      if (outcome.ok) {
        await storeClaude(outcome.token, deps.readClaudeEmail(), owner)
        return
      }
      switch (outcome.error) {
        case 'cancelled':
          update('claude', { phase: 'idle' })
          return
        case 'no_cli':
        case 'capture_failed':
          update('claude', { phase: 'paste', reason: outcome.error })
          return
        case 'denied':
        case 'timed_out':
          update('claude', { phase: 'failed', error: outcome.error })
      }
    })
  }

  function startCodex(): void {
    if (codexSession) {
      return
    }
    // Updates from a cancelled run are dropped (the driver reports its first step synchronously).
    const run = { live: true }
    codexRun = run
    const owner = identity()
    const session = startCodexBrokerSession({
      client: deps.client!,
      now,
      ...(deps.codexPollMs ? { pollMs: deps.codexPollMs } : {}),
      onUpdate: (setup) => {
        if (!run.live) {
          return
        }
        if (identity() !== owner) {
          void stopCodexRun()?.cancel()
          update('codex', { phase: 'failed', error: 'signed_out' })
          return
        }
        update('codex', setup)
      }
    })
    codexSession = session
    void session.done.finally(() => {
      if (codexSession === session) {
        codexSession = null
      }
    })
  }

  return {
    setups: (): OrcaCloudAgentSetups => {
      followIdentity()
      return setups
    },

    status: (): Promise<OrcaCloudAgentsResult<OrcaCloudAgentsStatus>> => {
      followIdentity()
      return attempt(async (client) => {
        const [credentials, sources] = await Promise.all([client.credentials(), client.sources()])
        return { credentials, sources }
      })
    },

    start: (agent: OrcaCloudAccountAgent): OrcaCloudAgentsResult<true> => {
      if (!deps.client) {
        return { ok: false, error: 'not_configured' }
      }
      followIdentity()
      if (agent === 'claude') {
        startClaude()
      } else {
        startCodex()
      }
      return { ok: true, value: true }
    },

    cancel: async (agent: OrcaCloudAccountAgent): Promise<void> => {
      if (agent === 'claude') {
        // A token already on its way to the Orca account finishes; the row shows the result.
        if (claudeSaving) {
          return
        }
        stopClaudeRun()
        update('claude', { phase: 'idle' })
        return
      }
      const session = stopCodexRun()
      update('codex', { phase: 'idle' })
      await session?.cancel()
    },

    /** "Open again" (Claude) / "Open page" (Codex): the provider's page, never anything else. */
    reopen: async (agent: OrcaCloudAccountAgent): Promise<boolean> => {
      const current = setups[agent]
      const url =
        agent === 'claude' ? claudeUrl : current.phase === 'device' ? current.verificationUrl : null
      if (!url || !isProviderSignInUrl(agent, url)) {
        return false
      }
      await deps.openExternal(url)
      return true
    },

    /** "Paste the token instead": stop setup-token and show the masked field. */
    usePaste: (): void => {
      if (claudeSaving) {
        return
      }
      stopClaudeRun()
      update('claude', { phase: 'paste', reason: 'chosen' })
    },

    /** The renderer sends the pasted value once; the reply never includes it. */
    pasteClaudeToken: async (raw: string): Promise<OrcaCloudAgentsResult<true>> => {
      const token = raw.trim()
      if (!CLAUDE_SETUP_TOKEN_PATTERN.test(token)) {
        return { ok: false, error: 'invalid_token' }
      }
      if (claudeSaving) {
        return { ok: false, error: 'unavailable' }
      }
      stopClaudeRun()
      // A pasted token may come from another account, so no label: the server names it.
      const result = await storeClaude(token, null, identity())
      if (!result.ok && result.error === 'invalid_token') {
        // Keep the field open so the person can paste again.
        update('claude', { phase: 'paste', reason: 'chosen' })
      }
      return result
    },

    /** Back to idle once the renderer has read the saved credential. */
    acknowledge: (agent: OrcaCloudAccountAgent): void => {
      const phase = setups[agent].phase
      if (phase === 'saved' || phase === 'failed') {
        update(agent, { phase: 'idle' })
      }
    },

    remove: (agent: OrcaCloudAccountAgent): Promise<OrcaCloudAgentsResult<AgentCredentialsView>> =>
      attempt((client) => client.remove(agent)),

    setDefaultSource: (
      agent: OrcaCloudAccountAgent,
      source: AgentSource
    ): Promise<OrcaCloudAgentsResult<AgentSourcesView>> =>
      attempt((client) => client.setDefaultSource(agent, source))
  }
}

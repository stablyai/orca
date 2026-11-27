import {
  isValidAppVersion,
  parseCliVersion
} from '../../../../shared/app-lifecycle/identity/app-version'
import { BoundedMap } from '../../../../shared/collections/bounded-map'
import { onAgentCliUpdateFinished } from '../../../agent-cli-update/agent-cli-update-service'
import { agentExecutableStamp } from '../../../native-chat/agent-model-catalog/agent-model-catalog-input-stamp'
import { resolveProviderChildEnv } from '../../../provider-process/provider-process-launch'
import { readCodexCliVersion } from './codex-cli-installation-error'
import type {
  CodexSession,
  CodexStructuredLaunch
} from '../session-lifecycle/codex-structured-session-state'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'

const STOCK_CODEX_SCOPE = '\0stock'
const MAX_OBSERVED_SCOPES = 64

type ObservedCatalogVersion = {
  readonly version: string
  readonly sequence: number
}

export type CodexLaunchedCli = {
  readonly scopeKey: string
  readonly command: string
  readonly prefixArgs: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly stamp: string | null
  readonly codexVersion: string | null
  readonly initializeVersion: string | null
  readonly observedSequenceAtLaunch: number
  updateEpoch: number
}

export type CodexCliFreshnessDeps = {
  executableStamp?: typeof agentExecutableStamp
  readVersion?: typeof readCodexCliVersion
}

export function parseCodexInitializeVersion(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return null
  }
  const userAgent = (result as { userAgent?: unknown }).userAgent
  if (typeof userAgent !== 'string') {
    return null
  }
  const match = /^[^\s/]+\/([^\s()]+)/.exec(userAgent.trim())
  const candidate = match?.[1]?.replace(/^v/i, '')
  return candidate && isValidAppVersion(candidate) ? parseCliVersion(candidate) : null
}

function codexScopeKey(input: { command: string; customCommand?: boolean }): string {
  return input.customCommand ? input.command : STOCK_CODEX_SCOPE
}

export class CodexCliFreshnessTracker {
  private readonly observedCatalogVersions = new BoundedMap<string, ObservedCatalogVersion>({
    maxEntries: MAX_OBSERVED_SCOPES
  })
  private observationSequence = 0
  private updateEpoch = 0

  observeCatalogVersion(
    input: { command: string; customCommand?: boolean },
    initializeResult: unknown
  ): void {
    const version = parseCodexInitializeVersion(initializeResult)
    if (!version) {
      return
    }
    this.observedCatalogVersions.set(codexScopeKey(input), {
      version,
      sequence: ++this.observationSequence
    })
  }

  noteCliUpdateFinished(): void {
    this.updateEpoch += 1
  }

  async captureLaunched(
    launch: Pick<
      CodexStructuredLaunch,
      'command' | 'prefixArgs' | 'cwd' | 'env' | 'envToDelete' | 'codexVersion' | 'customCommand'
    >,
    initializeResult: unknown,
    deps: CodexCliFreshnessDeps = {}
  ): Promise<CodexLaunchedCli> {
    // Capture epochs before async stat so updates finishing during startup are never missed.
    const observedSequenceAtLaunch = ++this.observationSequence
    const updateEpoch = this.updateEpoch
    const prefixArgs = launch.prefixArgs ? [...launch.prefixArgs] : []
    const env = resolveProviderChildEnv(launch, process.env)
    const stamp = await (deps.executableStamp ?? agentExecutableStamp)({
      command: launch.command,
      prefixArgs,
      cwd: launch.cwd,
      env
    })
    return {
      scopeKey: codexScopeKey(launch),
      command: launch.command,
      prefixArgs,
      cwd: launch.cwd,
      env,
      stamp,
      codexVersion: launch.codexVersion ?? null,
      initializeVersion: parseCodexInitializeVersion(initializeResult),
      observedSequenceAtLaunch,
      updateEpoch
    }
  }

  async isOutdated(launched: CodexLaunchedCli, deps: CodexCliFreshnessDeps = {}): Promise<boolean> {
    const observed = this.observedCatalogVersions.get(launched.scopeKey)
    if (
      observed &&
      observed.sequence > launched.observedSequenceAtLaunch &&
      launched.initializeVersion !== null &&
      observed.version !== launched.initializeVersion
    ) {
      return true
    }
    if (launched.stamp !== null) {
      const currentStamp = await (deps.executableStamp ?? agentExecutableStamp)({
        command: launched.command,
        prefixArgs: launched.prefixArgs,
        cwd: launched.cwd,
        env: launched.env
      })
      if (currentStamp !== null && currentStamp !== launched.stamp) {
        return true
      }
    }
    if (this.updateEpoch !== launched.updateEpoch) {
      const epoch = this.updateEpoch
      if (launched.codexVersion !== null) {
        const current = await (deps.readVersion ?? readCodexCliVersion)({
          program: launched.command,
          prefixArgs: launched.prefixArgs,
          cwd: launched.cwd,
          env: launched.env
        }).catch(() => ({ version: null }))
        if (current.version !== null && current.version !== launched.codexVersion) {
          return true
        }
      }
      launched.updateEpoch = epoch
    }
    return false
  }
}

const hostCodexCliFreshness = new CodexCliFreshnessTracker()
let listeningForUpdates = false

function ensureUpdateListener(): void {
  if (listeningForUpdates) {
    return
  }
  listeningForUpdates = true
  onAgentCliUpdateFinished((agent) => {
    if (agent === 'codex') {
      hostCodexCliFreshness.noteCliUpdateFinished()
    }
  })
}

export function observeCodexCatalogCliVersion(
  input: { command: string; customCommand?: boolean },
  initializeResult: unknown
): void {
  hostCodexCliFreshness.observeCatalogVersion(input, initializeResult)
}

export function captureCodexLaunchedCli(
  launch: Parameters<CodexCliFreshnessTracker['captureLaunched']>[0],
  initializeResult: unknown
): Promise<CodexLaunchedCli> {
  ensureUpdateListener()
  return hostCodexCliFreshness.captureLaunched(launch, initializeResult)
}

export function codexLaunchedCliOutdated(launched: CodexLaunchedCli): Promise<boolean> {
  return hostCodexCliFreshness.isOutdated(launched)
}

export function codexCliUpgradeRestart(
  sessions: ReadonlyMap<string, CodexSession>
): NonNullable<StructuredAgentSessionAdapter['requiresCliUpgradeRestart']> {
  return async (sessionId, fence) => {
    const session = sessions.get(sessionId)
    if (!session || session.ended || session.fence !== fence || !session.launchedCli) {
      return false
    }
    return await codexLaunchedCliOutdated(session.launchedCli)
  }
}

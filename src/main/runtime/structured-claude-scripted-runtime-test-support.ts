// A structured-session runtime whose Claude children are scripted: the production runtime,
// adapter, record store and host, with only the CLI process replaced.

import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ClaudeStreamJsonConnection,
  ClaudeStreamJsonConnectionHandlers,
  ClaudeStreamJsonLaunch,
  openClaudeStreamJsonConnection
} from '../claude/claude-stream-json-connection'
import { runClaudeControl } from '../claude/claude-agent-sdk-control-requests'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-launch-resolution'
import type { AgentSessionAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { hostTestAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

/** The error a real CLI's exit reaches the adapter as: Orca's message, the stderr as a log detail. */
export function scriptedClaudeExitError(diagnostic: string): Error {
  return withProviderDiagnostic(new Error(diagnostic), providerDiagnostic(diagnostic, 'log'))
}
export type ScriptedClaudeBehavior = {
  /** Initialize never answers; only the child's exit settles it. */
  initHangs?: boolean
  /** Every control read after startup's own settings read waits for `releaseStalls`. */
  stallsControlReads?: boolean
  /** The spawn itself waits for `releaseStalls`, holding its acquisition open. */
  spawnHangs?: boolean
  /** The CLI exits with this diagnostic before its spawn returns, or while its start time is read. */
  exitsDuringSpawn?: { diagnostic: string; at: 'spawn' | 'start-time-read' }
  /** Closing cannot prove the descendant tree gone, as when it was never snapshottable. */
  closeUnproven?: boolean
  /** Control requests run under this deadline, the way production's run under the default one. */
  controlTimeoutMs?: number
  /** Every option write (set_model, set_permission_mode, apply_flag_settings) goes unanswered. */
  optionWritesHang?: boolean
  /** Startup's own settings read goes unanswered. */
  startupSettingsReadHangs?: boolean
}

export type ScriptedClaudeChild = {
  sessionId: string
  launch: ClaudeStreamJsonLaunch
  calls: string[]
  handlers: ClaudeStreamJsonConnectionHandlers
  connection: Omit<ClaudeStreamJsonConnection, 'closed' | 'exitVerdict'> & {
    closed: boolean
    exitVerdict: ClaudeStreamJsonConnection['exitVerdict']
  }
  /** The CLI exits on its own: its root is gone, its tree unverifiable. */
  exit: (error: Error) => void
  /** The CLI answers initialize now; only meaningful under `initHangs`. */
  answerInit: () => void
}

export function createScriptedClaudeRuntime(sessionIds: readonly string[]) {
  const children: ScriptedClaudeChild[] = []
  const behaviors = new Map<string, ScriptedClaudeBehavior>()
  let releaseStalls = (): void => {}
  const stall = new Promise<void>((resolve) => {
    releaseStalls = resolve
  })
  let root: string | null = null
  let operations = 0

  const openConnection: typeof openClaudeStreamJsonConnection = async (launch, handlers = {}) => {
    const providerSessionId = String(launch.options.sessionId ?? launch.options.resume)
    const sessionId = sessionIds.find(
      (candidate) => claudeSessionIdForOrcaSession(candidate) === providerSessionId
    )
    if (!sessionId) {
      throw new Error(`no scripted Claude session for ${providerSessionId}`)
    }
    const behavior = behaviors.get(sessionId) ?? {}
    if (behavior.spawnHangs) {
      await stall
    }
    let failInit = (_error: Error): void => {}
    let answerInit = (): void => {}
    const answer = <T>(value: T, startup: boolean): Promise<T> =>
      behavior.stallsControlReads && !startup ? stall.then(() => value) : Promise.resolve(value)
    // Untimed unless the behavior sets a deadline; a hang then settles only on the child's exit.
    const control = <T>(subtype: string, run: () => Promise<T>): Promise<T> =>
      runClaudeControl(subtype, run, behavior.controlTimeoutMs ?? null)
    const never = <T>(): Promise<T> => new Promise<T>(() => {})
    const optionWrite = (subtype: string): Promise<void> => {
      child.calls.push(subtype)
      return control(subtype, () => (behavior.optionWritesHang ? never() : Promise.resolve()))
    }
    let settingsReads = 0
    const child: ScriptedClaudeChild = {
      sessionId,
      launch,
      calls: [],
      handlers,
      exit: (error) => {
        child.connection.exitVerdict = { root: 'exited', tree: 'unverifiable' }
        failInit(error)
        handlers.onExit?.(error)
      },
      answerInit: () => answerInit(),
      connection: {
        pid: 5000 + children.length,
        closed: false,
        exitVerdict: { root: 'live', tree: 'unverifiable' },
        initializationResult: () => {
          const initialized = { models: [{ value: 'sonnet', displayName: 'Sonnet' }] }
          const announce = (): void =>
            handlers.onMessage?.({
              type: 'system',
              subtype: 'init',
              session_id: providerSessionId,
              model: 'claude-sonnet-5',
              apiKeySource: 'none'
            })
          if (behavior.initHangs) {
            return new Promise((resolve, reject) => {
              failInit = reject
              answerInit = () => {
                announce()
                resolve(initialized)
              }
            })
          }
          announce()
          return Promise.resolve(initialized)
        },
        getContextUsage: () => {
          child.calls.push('get_context_usage')
          return Promise.resolve({})
        },
        getSettings: () => {
          child.calls.push('get_settings')
          settingsReads += 1
          const startup = settingsReads === 1
          return control('get_settings', () =>
            behavior.startupSettingsReadHangs && startup
              ? never()
              : answer({ effective: { effortLevel: 'high' } }, startup)
          )
        },
        supportedModels: () => {
          child.calls.push('list_models')
          return control('list_models', () =>
            answer(
              [
                { value: 'sonnet', displayName: 'Sonnet' },
                { value: 'opus', displayName: 'Opus' }
              ],
              false
            )
          )
        },
        setModel: () => optionWrite('set_model'),
        setPermissionMode: () => optionWrite('set_permission_mode'),
        applyFlagSettings: () => optionWrite('apply_flag_settings'),
        interrupt: async () => undefined,
        cancelAsyncMessage: async () => {},
        stopTask: async () => {},
        send: async () => {
          child.calls.push('send')
        },
        close: async () => {
          child.connection.closed = true
          return !behavior.closeUnproven
        }
      }
    }
    children.push(child)
    if (behavior.exitsDuringSpawn?.at === 'spawn') {
      exitAtSpawn(child, behavior.exitsDuringSpawn.diagnostic)
    }
    return child.connection
  }
  const exitAtSpawn = (child: ScriptedClaudeChild, diagnostic: string): void => {
    child.connection.closed = true
    child.exit(scriptedClaudeExitError(diagnostic))
  }
  /** A pid whose process is gone has no start time to read. */
  const readProcessStartTime = async (pid: number): Promise<number | null> => {
    const child = children.find((entry) => entry.connection.pid === pid)
    const exits = child ? behaviors.get(child.sessionId)?.exitsDuringSpawn : undefined
    if (child && exits?.at === 'start-time-read' && !child.connection.closed) {
      exitAtSpawn(child, exits.diagnostic)
      return pid * 10
    }
    return child?.connection.exitVerdict.root === 'exited' ? null : pid * 10
  }

  return {
    behave: (sessionId: string, behavior: ScriptedClaudeBehavior): void => {
      behaviors.set(sessionId, behavior)
    },
    /** The latest child spawned for `sessionId`. */
    child: (sessionId: string): ScriptedClaudeChild => {
      const found = children.findLast((entry) => entry.sessionId === sessionId)
      if (!found) {
        throw new Error(`no Claude child for ${sessionId}`)
      }
      return found
    },
    children: (sessionId: string): ScriptedClaudeChild[] =>
      children.filter((entry) => entry.sessionId === sessionId),
    install: async (): Promise<StructuredAgentSessionHost> => {
      root = await mkdtemp(join(tmpdir(), 'orca-scripted-claude-runtime-'))
      await mkdir(join(root, 'claude-home'), { recursive: true })
      const directory = root
      return ensureStructuredAgentSessionHost({
        stateDirectory: directory,
        hostId: 'local',
        claimKeyId: 'key-1',
        resolveWorkspacePath: async () => directory,
        resolveClaudeCommand: () => '/usr/local/bin/claude',
        resolveClaudeAuthPolicy: () => ({ stripAuthEnv: false }),
        openClaudeConnection: openConnection,
        readProcessStartTime
      })
    },
    attachParams: (
      sessionId: string,
      expectedRuntimeFence: number | null,
      overrides: Partial<AgentSessionAttachParams> = {}
    ) =>
      hostTestAttachParams(expectedRuntimeFence, {
        envelope: {
          sessionId,
          // The runtime's own clock admits operation ids, so these are minted against it.
          clientOperationId: `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`,
          expectedRuntimeFence,
          payloadFingerprint: ''
        },
        provider: 'claude',
        agent: 'claude',
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root ?? '', 'claude-home') },
        providerHandle: {
          kind: 'claude',
          sessionId: claudeSessionIdForOrcaSession(sessionId),
          leafUuid: null
        },
        ...overrides
      }),
    dispose: async (): Promise<void> => {
      releaseStalls()
      await stopStructuredAgentSessionRuntime()
      if (root) {
        await rm(root, { recursive: true, force: true })
        root = null
      }
    }
  }
}

import { fingerprintPreparedAgentLaunch } from '../../../daemon/prepared-agent-launch-payload'
import { createHash, randomUUID } from 'node:crypto'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../../../shared/agent-session/agent-session-host-authority'
import {
  isPreparedAgentLaunchStatus,
  type PreparedAgentLaunchDescriptor,
  type PreparedAgentLaunchIdentity
} from '../../../../shared/prepared-agent-launch'
import { PreparedLaunchNotAcceptedError } from './prepared-terminal-pending'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-types'
import type {
  PreparedAgentSpawn,
  PreparedTerminalPrompts
} from '../../../daemon/prepared-agent-launch-protocol'
import type { AgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import type { TerminalCreateOptions } from '../../runtime-terminal-contracts'
import { createObservedSetupCommand } from '../../../../shared/observed-setup-launch'
import { getSetupRunnerCommandPlatformForPath } from '../../../../shared/setup-runner-command'
import type { WorktreeSetupLaunch } from '../../../../shared/worktree/launch-types'
import { mintAgentSessionOperationId } from '../../orchestration/structured-pointer-operation-id'
import {
  publishPreparedTerminal,
  type PreparedPublicationPorts
} from './prepared-terminal-publication'
import {
  forgetPreparedPromptContinuation,
  hasPreparedPrompts,
  installPreparedPromptContinuation,
  PREPARED_LAUNCH_ROW_CALLER
} from './prepared-terminal-prompt-delivery'

export type PreparedTerminalStart = {
  spawn: PreparedAgentSpawn
  surface: AgentSessionSurfaceBinding
  options: TerminalCreateOptions
  commit: () => void
  release: () => void
}

export type PendingWorktreeAgentLaunch = PreparedAgentLaunchIdentity & {
  worktreeId: string
  tabId: string
  setupTerminalHandle?: string
}

export async function startPreparedWorktreeTerminals(args: {
  worktreeId: string
  setup?: WorktreeSetupLaunch
  startupOptions: TerminalCreateOptions
  prompts?: PreparedTerminalPrompts
  color?: string
  targetKind: PreparedAgentLaunchDescriptor['targetKind']
  ports: {
    controller: RuntimePtyController
    store: AgentSessionRecordStore
    prepare: (options: TerminalCreateOptions) => Promise<PreparedTerminalStart>
    createClaim: (operationId: string, spawn: PreparedAgentSpawn) => AgentSessionExecutionClaim
    createTerminal: (
      selector: string,
      options: TerminalCreateOptions
    ) => Promise<RuntimeTerminalCreate>
    setTabColor: (handle: string, color: string) => Promise<void>
    placePrimary?: PreparedPublicationPorts['placePrimary']
    notifyLaunchNotice?: PreparedPublicationPorts['notifyLaunchNotice']
    deliverPrompts: (
      terminal: RuntimeTerminalCreate,
      prompts: PreparedTerminalPrompts
    ) => Promise<boolean>
    onAgentPublished?: (terminal: RuntimeTerminalCreate) => void
  }
}): Promise<{
  pending: PendingWorktreeAgentLaunch
  setupTerminal?: RuntimeTerminalCreate
}> {
  const { ports } = args
  const controller = ports.controller
  if (!controller.preparedAgentLaunch) {
    throw new Error('prepared_agent_launch_unsupported')
  }
  const operationId = mintAgentSessionOperationId(Date.now())
  const attemptId = randomUUID()
  const observed = args.setup
    ? createObservedSetupCommand({
        runnerScriptPath: args.setup.runnerScriptPath,
        platform: getSetupRunnerCommandPlatformForPath(
          args.setup.runnerScriptPath,
          process.platform === 'win32' ? 'windows' : 'posix'
        ),
        shell: args.setup.shell,
        attemptId
      })
    : undefined
  const launch = await ports.prepare(args.startupOptions).catch((error: unknown) => {
    throw new PreparedLaunchNotAcceptedError(error)
  })
  let setup: PreparedTerminalStart | undefined
  let accepted = false
  let identity: PreparedAgentLaunchIdentity | undefined
  try {
    if (args.setup && observed) {
      setup = await ports.prepare({
        title: 'Setup',
        command: observed.command,
        env: { ...args.setup.envVars, ...observed.env },
        surfaceOwner: false,
        wslUserAct: args.startupOptions.wslUserAct
      })
    }
    const deadline = Date.now() + 2 * 60 * 60_000
    const payload = {
      launch: launch.spawn,
      publication: {
        ...(launch.options.launchConfig ? { launchConfig: launch.options.launchConfig } : {}),
        ...(launch.options.viewMode ? { viewMode: launch.options.viewMode } : {})
      },
      ...(setup ? { setup: { spawn: setup.spawn, attemptId, deadline } } : {})
    }
    const fingerprint = fingerprintPreparedAgentLaunch(payload)
    const prepared = await controller.preparedAgentLaunch({
      action: 'prepare',
      operationId,
      fingerprint,
      claim: ports.createClaim(operationId, launch.spawn),
      surface: launch.surface
    })
    if (!isPreparedAgentLaunchStatus(prepared)) {
      throw new Error('agent_session_ownership_unknown')
    }
    identity = {
      operationId,
      fingerprint,
      daemonGeneration: prepared.daemonGeneration,
      reservationGeneration: prepared.reservationGeneration
    }
    // Draft and followup stay with this flow; the daemon holds only the accepted launch itself.
    const promptOwnerRef = hasPreparedPrompts(args.prompts)
      ? installPreparedPromptContinuation(
          identity,
          prepared.claim.agent,
          args.prompts,
          ports.deliverPrompts
        )
      : undefined
    const descriptor: PreparedAgentLaunchDescriptor = {
      daemonGeneration: identity.daemonGeneration,
      reservationGeneration: identity.reservationGeneration,
      hostScope: {
        hostId: 'local',
        ...(launch.spawn.terminalWindowsWslDistro
          ? { distro: launch.spawn.terminalWindowsWslDistro }
          : {})
      },
      claim: prepared.claim,
      surface: prepared.surface,
      targetKind: args.targetKind,
      launchTokenHash: launch.spawn.env?.ORCA_AGENT_LAUNCH_TOKEN
        ? createHash('sha256').update(launch.spawn.env.ORCA_AGENT_LAUNCH_TOKEN).digest('hex')
        : null,
      ...(setup
        ? {
            setup: {
              operationId,
              attemptId,
              sessionId: setup.spawn.sessionId,
              terminalHandle: setup.surface.terminalHandle,
              deadline
            }
          }
        : {}),
      presentation: {
        tabId: prepared.surface.tabId,
        leafId: prepared.surface.leafId,
        primary: true,
        ...(args.color ? { color: args.color } : {}),
        ...(args.startupOptions.title ? { title: args.startupOptions.title } : {}),
        ...(launch.options.targetGroupId ? { groupId: launch.options.targetGroupId } : {}),
        ...(args.startupOptions.afterTabId
          ? { splitPlacement: { afterTabId: args.startupOptions.afterTabId } }
          : {})
      },
      ...(promptOwnerRef ? { promptOwnerRef } : {})
    }
    const recorded = await ports.store.recordPreparedAgentLaunch({
      callerKey: PREPARED_LAUNCH_ROW_CALLER,
      operationId,
      fingerprint,
      now: Date.now(),
      preparedLaunch: descriptor
    })
    if (recorded.claim?.claim !== 'won') {
      throw new Error('agent_session_operation_unknown')
    }
    // An acceptance whose reply is lost remains uncertain; do not cancel or select the old launch path.
    accepted = true
    const acceptedIdentity = identity
    const observe = () => {
      void publishPreparedTerminal(acceptedIdentity, descriptor, ports, launch.options)
        .then((terminal) => {
          if (terminal) {
            launch.commit()
            setup?.commit()
            ports.onAgentPublished?.(terminal)
          } else {
            launch.release()
            setup?.release()
          }
        })
        .catch(() => {})
    }
    let receipt
    try {
      receipt = await controller.preparedAgentLaunch({ action: 'accept', identity, ...payload })
    } catch {
      observe()
      return {
        pending: {
          ...identity,
          worktreeId: args.worktreeId,
          tabId: launch.surface.tabId,
          ...(setup ? { setupTerminalHandle: setup.surface.terminalHandle } : {})
        }
      }
    }
    if (!isPreparedAgentLaunchStatus(receipt) || !receipt.accepted) {
      observe()
      return {
        pending: {
          ...identity,
          worktreeId: args.worktreeId,
          tabId: launch.surface.tabId,
          ...(setup ? { setupTerminalHandle: setup.surface.terminalHandle } : {})
        }
      }
    }
    let setupTerminal: RuntimeTerminalCreate | undefined
    try {
      let observed = receipt
      if (setup && !observed.setup?.incarnationId && observed.execution === 'not-dispatched') {
        const next = await controller.preparedAgentLaunch({
          action: 'wait',
          identity,
          timeoutMs: 10_000,
          until: 'setup'
        })
        if (isPreparedAgentLaunchStatus(next)) {
          observed = next
        }
      }
      // A Setup that never ran is explained once, by the publication that retires its launch.
      if (setup && observed.setup?.incarnationId) {
        setupTerminal = await ports.createTerminal(`id:${args.worktreeId}`, {
          ...setup.options,
          command: undefined,
          env: undefined,
          sessionId: setup.spawn.sessionId,
          expectedIncarnationId: observed.setup.incarnationId,
          attachOnly: true
        })
      }
    } catch {
      // A fast Setup exit or detached subscriber cannot revoke the accepted continuation.
    }
    observe()
    return {
      pending: {
        ...identity,
        worktreeId: args.worktreeId,
        tabId: launch.surface.tabId,
        ...(setup
          ? { setupTerminalHandle: setupTerminal?.handle ?? setup.surface.terminalHandle }
          : {})
      },
      setupTerminal
    }
  } catch (error) {
    throw accepted ? error : new PreparedLaunchNotAcceptedError(error)
  } finally {
    if (!accepted) {
      let unused = !identity
      if (identity) {
        forgetPreparedPromptContinuation(identity)
        const cancelled = await controller
          .preparedAgentLaunch({ action: 'cancel', identity })
          .catch(() => null)
        unused = isPreparedAgentLaunchStatus(cancelled) && cancelled.retirement === 'unused-retired'
        if (unused) {
          await ports.store.retirePreparedAgentLaunch({
            callerKey: PREPARED_LAUNCH_ROW_CALLER,
            ...identity
          })
        }
      }
      if (unused) {
        launch.release()
        setup?.release()
      }
    }
  }
}

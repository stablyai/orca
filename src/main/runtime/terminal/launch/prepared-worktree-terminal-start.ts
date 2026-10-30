import { fingerprintPreparedAgentLaunch } from '../../../daemon/prepared-agent-launch-payload'
import { createHash, randomUUID } from 'node:crypto'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../../../shared/agent-session-host-authority'
import {
  isPreparedAgentLaunchStatus,
  type PreparedAgentLaunchDescriptor,
  type PreparedAgentLaunchIdentity
} from '../../../../shared/prepared-agent-launch'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-types'
import type {
  PreparedAgentSpawn,
  PreparedTerminalPrompts
} from '../../../daemon/prepared-agent-launch-protocol'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import type { TerminalCreateOptions } from '../../runtime-terminal-contracts'
import { buildObservedSetupCommand } from '../../orchestration/setup-completion-signal'
import { getSetupRunnerCommandPlatformForPath } from '../../../../shared/setup-runner-command'
import type { WorktreeSetupLaunch } from '../../../../shared/worktree/launch-types'
import { mintAgentSessionOperationId } from '../../orchestration/structured-pointer-operation-id'
import {
  publishPreparedTerminal,
  type PreparedPublicationPorts
} from './prepared-terminal-publication'

export type PreparedTerminalStart = {
  spawn: PreparedAgentSpawn
  surface: AgentSessionSurfaceBinding
  options: TerminalCreateOptions
  commit: () => void
  release: () => void
}

export type PendingWorktreeAgentLaunch = PreparedAgentLaunchIdentity & {
  worktreeId: string
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
    deliverPrompts: (
      terminal: RuntimeTerminalCreate,
      prompts: PreparedTerminalPrompts
    ) => Promise<boolean>
    onAgentPublished?: (terminal: RuntimeTerminalCreate) => void
  }
}): Promise<{ pending: PendingWorktreeAgentLaunch; setupTerminal?: RuntimeTerminalCreate }> {
  const { ports } = args
  const controller = ports.controller
  if (!controller.preparedAgentLaunch) {
    throw new Error('prepared_agent_launch_unsupported')
  }
  const operationId = mintAgentSessionOperationId(Date.now())
  const attemptId = randomUUID()
  const observed = args.setup
    ? buildObservedSetupCommand(
        args.setup.runnerScriptPath,
        getSetupRunnerCommandPlatformForPath(
          args.setup.runnerScriptPath,
          process.platform === 'win32' ? 'windows' : 'posix'
        ),
        attemptId,
        args.setup.shell
      )
    : undefined
  const launch = await ports.prepare(args.startupOptions)
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
      prompts: args.prompts,
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
      }
    }
    const recorded = await ports.store.recordPreparedAgentLaunch({
      callerKey: 'worktree-startup',
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
        ...(setup
          ? { setupTerminalHandle: setupTerminal?.handle ?? setup.surface.terminalHandle }
          : {})
      },
      setupTerminal
    }
  } finally {
    if (!accepted) {
      let unused = !identity
      if (identity) {
        const cancelled = await controller
          .preparedAgentLaunch({ action: 'cancel', identity })
          .catch(() => null)
        unused = isPreparedAgentLaunchStatus(cancelled) && cancelled.retirement === 'unused-retired'
        if (unused) {
          await ports.store.retirePreparedAgentLaunch(identity)
        }
      }
      if (unused) {
        launch.release()
        setup?.release()
      }
    }
  }
}

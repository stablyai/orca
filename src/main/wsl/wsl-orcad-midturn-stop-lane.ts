// verify-7 on real WSL: a distro stopped mid-reply stays down under the chat's polls, the chat's
// Start boots it through the host service, and Continue finishes the cut turn.
import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { z } from 'zod'
import { AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY } from '../../shared/agent-session-continue-interrupted-capability'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type {
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../shared/agent-session-wire'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import { subscribeRemoteRuntimeRequest } from '../../shared/remote-runtime/remote-runtime-client'
import { latestNativeChatOrcaStopCut } from '../../shared/native-chat/native-chat-orca-stop-cut'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import type { WslHostStatus } from '../../shared/wsl-host-types'
import { claudeSessionIdForOrcaSession } from '../claude/structured/claude-structured-session-id'
import { hasOrcadTemplate } from '../orcad/orcad-artifact-materializer'
import { packagedClaudeChatScenario } from '../orcad/orcad-structured-chat-scenario'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { wslHostStoppedMessage } from './wsl-host-add-admission'
import { wslHostConnectOptions } from './wsl-host-connect-request'
import { createWslHostConnector } from './wsl-host-connector'
import type { WslHostConnector } from './wsl-host-connector-contract'
import { WslHostService } from './wsl-host-service'
import { assistantText } from './wsl-orcad-chat-assistant-text'
import { envelope } from './wsl-orcad-chat-envelope'
import {
  WslChatProviderReport,
  providerReportLogLength,
  waitForProviderReportInLog,
  writeChatFixtureFile,
  type WslChatHost
} from './wsl-orcad-chat-provider-fixture'

/** Polls the running list (and the chat's runtime call) this long after the terminate returns. */
const STAYS_STOPPED_MS = 30_000
const POLL_MS = 5_000

export type LaneWslHost = {
  service: WslHostService
  connector: WslHostConnector
  /** Everything the service published, as the window's status listener receives it. */
  published: WslHostStatus[]
}

/** The production service and connector, wired as wsl-host-handlers wires them minus Electron. */
export function createLaneWslHost(userDataPath: string): LaneWslHost {
  const published: WslHostStatus[] = []
  const service = new WslHostService({
    userDataPath: () => userDataPath,
    isEnabled: () => true,
    hasServerFiles: hasOrcadTemplate,
    publish: (status) => {
      published.push(status)
      console.log(`[lane] host ${JSON.stringify(status)}`)
    },
    pairingChanged: () => {},
    ready: () => {},
    removed: () => {}
  })
  const refuse = (): Promise<never> => Promise.reject(new Error('The lane never removes a host'))
  const connector = createWslHostConnector({
    userDataPath,
    onChange: service.handleConnectionChange.bind(service),
    hasUserVisibleWork: (distro) => service.hasUserVisibleWork(distro),
    isKnownDistro: (distro) => service.isKnownDistro(distro),
    runtime: { call: refuse, census: refuse }
  })
  service.attach(connector)
  return { service, connector, published }
}

export type MidTurnStopLane = Pick<WslChatHost, 'rpc' | 'guest'> & {
  /** The host connection's pairing, read at each call: Start replaces the connection. */
  pairing(): PairedRuntimeConnection
  distro: string
  environmentId: string
  host: LaneWslHost
  terminate(): Promise<void>
  /** Holder keys of the distros `wsl --list --running` confirms. */
  runningDistros(): Promise<string[]>
}

/** The provider's partial reply waits for an acknowledgement long enough to stop the distro under it. */
function heldReplyScenario(providerId: string, ackPath: string) {
  const scenario = packagedClaudeChatScenario(providerId, ackPath)
  return {
    ...scenario,
    steps: scenario.steps.map((step) =>
      step.awaitFile ? { awaitFile: { ...step.awaitFile, timeoutMs: 120_000 } } : step
    )
  }
}

/** Streamed assistant text, as the open chat sees it; history keeps only settled rows. */
type Watch = { close(): void }

async function watchAssistantText(lane: MidTurnStopLane, sessionId: string, opened: Watch[]) {
  const text: string[] = []
  const errors: Error[] = []
  const subscription = await subscribeRemoteRuntimeRequest<AgentSessionSubscribeEvent>(
    lane.pairing(),
    'agentSession.subscribe',
    { sessionId },
    30_000,
    {
      onResponse(response) {
        if (!response.ok) {
          errors.push(new Error(JSON.stringify(response.error)))
          return
        }
        const event = response.result
        const rows =
          event.type === 'batch'
            ? event.batch.items
            : event.type === 'snapshot' || event.type === 'reset'
              ? event.page.items
              : []
        text.push(...rows.map(assistantText))
      },
      onError(error) {
        errors.push(error)
      }
    },
    { clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES }
  )
  let closed = false
  const watch = {
    text,
    errors,
    close: () => {
      if (!closed) {
        closed = true
        subscription.close()
      }
    }
  }
  opened.push(watch)
  return watch
}

type MidTurnFixture = { root: string; worktree: string; cwd: string }

export async function proveWslMidTurnStopAndContinue(
  lane: MidTurnStopLane,
  fixture: MidTurnFixture
) {
  // A failed wait must not leave a stream open until the step times out.
  const opened: Watch[] = []
  try {
    return await stopMidTurnThenContinue(lane, fixture, opened)
  } finally {
    opened.forEach((watch) => watch.close())
  }
}

async function stopMidTurnThenContinue(
  lane: MidTurnStopLane,
  fixture: MidTurnFixture,
  opened: Watch[]
) {
  const { distro, environmentId, host } = lane
  const sessionId = randomUUID()
  const providerId = claudeSessionIdForOrcaSession(sessionId)
  const ackPath = `${fixture.root}/midturn-partial-observed`
  // agentDefaultEnv points the guest Claude at these.
  const scenarioPath = `${fixture.root}/scenario.json`
  const reportLogPath = `${fixture.root}/report-log.jsonl`
  const items = async (): Promise<AgentJournalRenderItem[]> =>
    (
      await lane.rpc<AgentSessionHistoryResult>('agentSession.history', {
        sessionId,
        direction: 'tail',
        limit: 100
      })
    ).page.items
  await lane.guest(`rm -f ${quotePosixShell(ackPath)} ${quotePosixShell(reportLogPath)}`)
  await writeChatFixtureFile(
    lane,
    scenarioPath,
    JSON.stringify(heldReplyScenario(providerId, ackPath))
  )
  const fields = { worktree: fixture.worktree, agent: 'claude' }
  const created = z.object({ ok: z.literal(true), value: z.object({ fence: z.number() }) }).parse(
    await lane.rpc('agentSession.create', {
      ...fields,
      envelope: envelope(sessionId, 'agentSession.create', fields, null)
    })
  )
  const held = await watchAssistantText(lane, sessionId, opened)
  const body = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Reply slowly; the distro stops under you.' }]
  }
  expect(
    await lane.rpc('agentSession.send', {
      body,
      envelope: envelope(sessionId, 'agentSession.send', { body }, created.value.fence)
    })
  ).toMatchObject({ ok: true })
  await vi.waitFor(
    async () => {
      expect(held.errors).toEqual([])
      const rows = await items()
      expect(held.text, JSON.stringify(rows.map((row) => row.body))).toContain('Packaged server ')
      expect(rows.some((row) => readAgentJournalTurn(row.body)?.state === 'running')).toBe(true)
    },
    { timeout: 30_000, interval: 250 }
  )

  // Mid-reply, the distro stops under the open turn while the chat stays on screen.
  host.service.setVisibleWork([environmentId])
  const since = host.published.length
  let started = performance.now()
  // The stop ends the stream; the chat's stopped state is the host status below.
  held.close()
  await lane.terminate()
  const terminatedAt = performance.now()
  const stoppedMessage = wslHostStoppedMessage(distro)
  await vi.waitFor(
    () =>
      expect(host.published.slice(since)).toContainEqual(
        expect.objectContaining({ environmentId, state: 'distro-stopped' })
      ),
    { timeout: 30_000, interval: 100 }
  )
  const stopShownMs = Math.round(performance.now() - started)
  // Nothing boots it: not liveness, not the chat's own runtime calls, not a running-list poll.
  let polls = 0
  for (;;) {
    expect(
      await lane.runningDistros(),
      `${distro} rebooted ${polls * POLL_MS} ms in`
    ).not.toContain(wslDistroHolderKey(distro))
    await expect(host.service.ensureForRuntimeCall(environmentId)).rejects.toThrow(stoppedMessage)
    polls += 1
    if (performance.now() - terminatedAt >= STAYS_STOPPED_MS) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  const shown = (state: WslHostStatus['state']) =>
    expect(host.service.getStatuses()).toContainEqual(
      expect.objectContaining({ environmentId, state })
    )
  shown('distro-stopped')

  // The chat's Start: the renderer's wslHosts.connect for this environment.
  started = performance.now()
  await host.service.connect(
    environmentId,
    wslHostConnectOptions({ withdrawPendingRemoval: false })
  )
  const startMs = Math.round(performance.now() - started)
  expect(await lane.runningDistros()).toContain(wslDistroHolderKey(distro))
  await vi.waitFor(() => shown('ready'), { timeout: 30_000, interval: 100 })
  const status = z
    .object({ capabilities: z.array(z.string()).optional() })
    .parse(await lane.rpc('status.get'))
  expect(status.capabilities).toContain(AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY)
  // What NativeChatInterruptedContinue offers: the latest turn, cut by Orca's stop.
  const cut = await vi.waitFor(
    async () => {
      const rows = await items()
      const found = latestNativeChatOrcaStopCut(rows, [])
      if (!found) {
        throw new Error(`No Continue offered yet: ${JSON.stringify(rows.map((row) => row.body))}`)
      }
      return { ...found, before: rows.map((row) => row.itemId) }
    },
    { timeout: 60_000, interval: 500 }
  )

  await writeChatFixtureFile(
    lane,
    scenarioPath,
    JSON.stringify(packagedClaudeChatScenario(providerId, ackPath))
  )
  await lane.guest(`touch ${quotePosixShell(ackPath)}`)
  const resumedWatch = await watchAssistantText(lane, sessionId, opened)
  // The held turn's own launch logged the same session id; only a later launch is the Continue.
  const loggedBeforeContinue = await providerReportLogLength(lane, reportLogPath)
  const continued = z.object({ outcome: z.string() }).parse(
    await lane.rpc('agentSession.continueInterrupted', {
      sessionId,
      turnItemId: cut.turnItemId
    })
  )
  expect(['continued', 'pending']).toContain(continued.outcome)
  await vi.waitFor(
    async () => {
      const rows = await items()
      expect(resumedWatch.errors).toEqual([])
      expect(resumedWatch.text).toContain('Packaged server reply.')
      expect(
        rows.some(
          (row) =>
            row.body?.kind === 'turn' &&
            row.body.state === 'completed' &&
            row.body.outcome === 'success' &&
            !cut.before.includes(row.itemId)
        )
      ).toBe(true)
    },
    { timeout: 60_000, interval: 500 }
  )
  // The held turn's stream frames leave no transcript head, so Continue may relaunch the same
  // provider session with --session-id rather than --resume; either is the continued turn.
  const resumedArgv = new RegExp(`--(?:resume|session-id)(?:=| )${providerId}`)
  // The restarted server's model discovery relaunches the same CLI after the turn, so the log.
  const resumed = await waitForProviderReportInLog(
    lane,
    reportLogPath,
    WslChatProviderReport,
    (written) => resumedArgv.test(written.argv.join(' ')) && written.userMessages.length > 0,
    `the continued turn after line ${loggedBeforeContinue}`,
    loggedBeforeContinue
  )
  expect(resumed.cwd).toBe(fixture.cwd)
  await lane.rpc('agentSession.close', { sessionId })
  return {
    sessionId,
    stopShownMs,
    stayedStoppedPolls: polls,
    startMs,
    cause: cut.cause,
    continued: continued.outcome
  }
}

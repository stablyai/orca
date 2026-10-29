import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { z } from 'zod'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { assistantText } from './wsl-orcad-chat-assistant-text'
import type {
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../shared/agent-session-wire'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription
} from '../../shared/remote-runtime/remote-runtime-client'
import { claudeSessionIdForOrcaSession } from '../claude/structured/claude-structured-session-id'
import { packagedClaudeChatScenario } from '../orcad/orcad-structured-chat-scenario'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { wslClaudeChatScenario } from './wsl-orcad-chat-scenario'
import { envelope } from './wsl-orcad-chat-envelope'
import { exerciseScriptedProviderChat } from './wsl-orcad-scripted-provider-chat'
import {
  expectWindowsDecoyReachable,
  expectWindowsDecoyUnrun,
  expectWindowsOnlyChatRefused,
  probeWindowsDecoy
} from './wsl-orcad-chat-windows-decoy'
import {
  installWslChatFixture,
  WslChatProviderReport,
  waitForProviderReport,
  writeChatFixtureFile,
  type WslChatHost
} from './wsl-orcad-chat-provider-fixture'

export type ChatLane = WslChatHost & {
  pairing(): PairedRuntimeConnection
  reconnect(whileDisconnected: () => Promise<void>): Promise<void>
}

export type ChatInstall = { home: string; root: string; script: string; cli: string }

async function exerciseChat(
  lane: ChatLane,
  { root, script, cli }: ChatInstall,
  worktree: string,
  cwd: string
) {
  const sessionId = randomUUID()
  const providerId = claudeSessionIdForOrcaSession(sessionId)
  const ackPath = `${root}/partial-observed`
  const scenarioPath = `${root}/scenario.json`
  const reportPath = `${root}/report.json`
  await lane.guest(`rm -f ${quotePosixShell(ackPath)}`)
  await writeChatFixtureFile(
    lane,
    scenarioPath,
    JSON.stringify(wslClaudeChatScenario(providerId, ackPath))
  )
  const fields = { worktree, agent: 'claude' }
  const created = await lane.rpc('agentSession.create', {
    ...fields,
    envelope: envelope(sessionId, 'agentSession.create', fields, null)
  })
  const {
    value: { fence }
  } = z.object({ ok: z.literal(true), value: z.object({ fence: z.number() }) }).parse(created)
  const rows = new Map<string, AgentJournalRenderItem>()
  const text: string[] = []
  const errors: Error[] = []
  let dropping = false
  let subscription: RemoteRuntimeSubscription | undefined
  const subscribe = async () =>
    subscribeRemoteRuntimeRequest<AgentSessionSubscribeEvent>(
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
          const items =
            event.type === 'batch'
              ? event.batch.items
              : event.type === 'snapshot' || event.type === 'reset'
                ? event.page.items
                : []
          for (const row of items) {
            rows.set(row.itemId, row)
            text.push(assistantText(row))
          }
        },
        onError(error) {
          if (!dropping) {
            errors.push(error)
          }
        }
      },
      { clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES }
    )
  try {
    subscription = await subscribe()
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII='
    const upload = await lane.rpc<{ uploadId: string }>('agentSessionAttachment.uploadStart', {
      sessionId,
      name: 'wsl image.png',
      byteLength: Buffer.from(png, 'base64').length
    })
    await lane.rpc('agentSessionAttachment.uploadAppend', {
      ...upload,
      offset: 0,
      contentBase64: png
    })
    const attachment = await lane.rpc<{ path: string }>(
      'agentSessionAttachment.uploadCommit',
      upload
    )
    expect(attachment.path).toMatch(/^\//u)
    expect(await lane.guest(`base64 -w0 ${quotePosixShell(attachment.path)}`)).toBe(png)
    const body = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'Inspect this image, then wait for Stop.' },
        { type: 'image-ref', path: attachment.path }
      ]
    }
    expect(
      await lane.rpc('agentSession.send', {
        body,
        envelope: envelope(sessionId, 'agentSession.send', { body }, fence)
      })
    ).toMatchObject({ ok: true })
    await vi.waitFor(
      () => {
        expect(errors).toEqual([])
        expect(text).toContain('Packaged server ')
      },
      { timeout: 30_000 }
    )
    dropping = true
    // Close the actual WSL bridge, not just the chat subscription; the guest owns the turn.
    await lane.reconnect(async () => {
      await lane.guest(`touch ${quotePosixShell(ackPath)}`)
    })
    subscription.close()
    rows.clear()
    text.length = 0
    dropping = false
    subscription = await subscribe()
    await vi.waitFor(
      () => {
        expect(errors).toEqual([])
        expect(text).toContain('Packaged server reply.')
        expect([...rows.values()].some((row) => row.body?.kind === 'approval')).toBe(true)
      },
      { timeout: 30_000 }
    )
    const approval = [...rows.values()].find((row) => row.body?.kind === 'approval')
    if (!approval) {
      throw new Error('Missing streamed approval')
    }
    const answer = {
      itemId: approval.itemId,
      expectedRevision: approval.revision,
      optionId: 'allow'
    }
    expect(
      await lane.rpc('agentSession.respondToApproval', {
        ...answer,
        envelope: envelope(sessionId, 'agentSession.respondTo:approval', answer, fence)
      })
    ).toMatchObject({ ok: true })
    expect(
      await lane.rpc('agentSession.cancel', {
        envelope: envelope(sessionId, 'agentSession.cancel', {}, fence)
      })
    ).toMatchObject({ ok: true, value: { cancelled: true } })
    const report = await waitForProviderReport(
      lane,
      reportPath,
      WslChatProviderReport,
      (written) => written.controlRequests.some((entry) => entry.request.subtype === 'interrupt'),
      'the Stop interrupt'
    )
    expect(report.cwd).toBe(cwd)
    expect(report.execPath).toMatch(/^\//u)
    // Found on the guest's login PATH, not through a Command setting.
    expect(report.argv[0]).toBe(script)
    expect(report.env.ORCA_LANE_CLI_WRAPPER).toBe(cli)
    expect(report.env).toMatchObject({
      ORCA_AGENT_SESSION_ID: sessionId,
      ORCA_STRUCTURED_SESSION: '1'
    })
    expect(report.controlResponses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          response: expect.objectContaining({
            response: expect.objectContaining({ behavior: 'allow' })
          })
        })
      ])
    )
    expect(report.userMessages).toHaveLength(1)
    expect(report.userMessages[0]?.message.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image', source: expect.objectContaining({ data: png }) })
      ])
    )
    // Close releases the provider; the saved host record must resume the same conversation.
    subscription.close()
    await lane.rpc('agentSession.close', { sessionId })
    await writeChatFixtureFile(
      lane,
      scenarioPath,
      JSON.stringify(packagedClaudeChatScenario(providerId, ackPath))
    )
    rows.clear()
    const history = await lane.rpc<AgentSessionHistoryResult>('agentSession.history', {
      sessionId,
      direction: 'tail',
      limit: 100
    })
    const resumedBody = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue after Stop.' }]
    }
    subscription = await subscribe()
    if (history.page.fence === undefined) {
      throw new Error('Missing host fence')
    }
    expect(
      await lane.rpc('agentSession.send', {
        body: resumedBody,
        envelope: envelope(
          sessionId,
          'agentSession.send',
          { body: resumedBody },
          history.page.fence
        )
      })
    ).toMatchObject({ ok: true })
    await vi.waitFor(
      () => {
        expect(errors).toEqual([])
        expect(
          [...rows.values()].some(
            (row) =>
              row.body?.kind === 'turn' &&
              row.body.state === 'completed' &&
              row.body.outcome === 'success' &&
              !history.page.items.some((old) => old.itemId === row.itemId)
          )
        ).toBe(true)
      },
      { timeout: 30_000 }
    )
    const resumedArgv = new RegExp(`--resume(?:=| )${providerId}`)
    const resumed = await waitForProviderReport(
      lane,
      reportPath,
      WslChatProviderReport,
      (written) => resumedArgv.test(written.argv.join(' ')) && written.userMessages.length > 0,
      'the resumed turn'
    )
    expect(resumed.cwd).toBe(cwd)
    expect(resumed.argv.join(' ')).toMatch(resumedArgv)
    expect(resumed.userMessages).toHaveLength(1)
    return {
      sessionId,
      providerId,
      cwd,
      attachment: attachment.path
    }
  } finally {
    subscription?.close()
    await lane.rpc('agentSession.close', { sessionId })
  }
}

/** Same cross-process contract for git and folder projects, in each imported distro. */
export async function proveWslStructuredChat(lane: ChatLane) {
  const install = await installWslChatFixture(lane)
  const { home, folderWorktree, folderPath } = install
  const gitWorktree = `path:${home}/wsl-orcad-lane-repo`
  const git = await exerciseChat(lane, install, gitWorktree, `${home}/wsl-orcad-lane-repo`)
  const folder = await exerciseChat(lane, install, folderWorktree, folderPath)
  // One workspace kind each keeps the lane short; Claude already covers both.
  const codex = await exerciseScriptedProviderChat(
    lane,
    install.codex,
    gitWorktree,
    `${home}/wsl-orcad-lane-repo`
  )
  const grok = await exerciseScriptedProviderChat(lane, install.grok, folderWorktree, folderPath)
  const decoy = await expectWindowsDecoyReachable(lane)
  await expectWindowsDecoyUnrun(lane, home)
  const windowsOnly = await probeWindowsDecoy(lane, install, gitWorktree)
  expect(windowsOnly.errors, JSON.stringify(windowsOnly)).toEqual([])
  const windowsOnlyChat = await expectWindowsOnlyChatRefused(lane, gitWorktree)
  await expectWindowsDecoyUnrun(lane, home)
  return { git, folder, codex, grok, decoy, windowsOnly, windowsOnlyChat }
}

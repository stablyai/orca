import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { z } from 'zod'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { subscribeRemoteRuntimeRequest } from '../../shared/remote-runtime/remote-runtime-client'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import {
  waitForProviderReport,
  type WslScriptedProviderInstall
} from './wsl-orcad-chat-provider-fixture'
import { assistantText } from './wsl-orcad-chat-assistant-text'
import { envelope } from './wsl-orcad-chat-envelope'
import type { ChatLane } from './wsl-orcad-structured-chat-contract'

const ScriptedProviderReport = z.object({
  argv: z.array(z.string()),
  execPath: z.string(),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  methods: z.array(z.string()),
  approvalResponses: z.array(z.unknown()).optional(),
  permissionResponses: z.array(z.unknown()).optional()
})

/** Per provider: its approval answer, account home variable and what the fixture records for argv, the answer and Stop. */
const PROVIDERS = {
  codex: {
    reply: 'Guest codex reply.',
    optionId: 'accept',
    accountVar: 'CODEX_HOME',
    argv: ['app-server'],
    stopMethod: 'turn/interrupt',
    answered: (report: z.infer<typeof ScriptedProviderReport>) => report.approvalResponses,
    answer: { decision: 'accept' }
  },
  grok: {
    reply: 'Guest grok reply.',
    optionId: 'allow',
    accountVar: 'GROK_HOME',
    argv: ['agent', 'stdio'],
    stopMethod: 'session/cancel',
    answered: (report: z.infer<typeof ScriptedProviderReport>) => report.permissionResponses,
    answer: { outcome: { outcome: 'selected', optionId: 'allow' } }
  },
  // OpenCode 1.x dialect: once/always/reject options, message-id chunks, `acp` with its own env.
  opencode: {
    reply: 'Guest opencode reply.',
    optionId: 'once',
    accountVar: 'XDG_DATA_HOME',
    argv: ['acp'],
    stopMethod: 'session/cancel',
    answered: (report: z.infer<typeof ScriptedProviderReport>) => report.permissionResponses,
    answer: { outcome: { outcome: 'selected', optionId: 'once' } },
    env: { OPENCODE_CLIENT: 'acp', OPENCODE_ENABLE_QUESTION_TOOL: 'false' }
  }
} as const

/** Streaming, approval and Stop through orcad for a scripted guest Codex or ACP agent (Grok, OpenCode). */
export async function exerciseScriptedProviderChat(
  lane: ChatLane,
  install: WslScriptedProviderInstall,
  worktree: string,
  cwd: string
) {
  const provider = PROVIDERS[install.agent]
  const sessionId = randomUUID()
  await lane.guest(
    `rm -f ${quotePosixShell(install.ackPath)} ${quotePosixShell(install.reportPath)}`
  )
  const fields = { worktree, agent: install.agent }
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
        errors.push(error)
      }
    },
    { clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES }
  )
  try {
    const body = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Run pwd in the guest, then wait for Stop.' }]
    }
    expect(
      await lane.rpc('agentSession.send', {
        body,
        envelope: envelope(sessionId, 'agentSession.send', { body }, fence)
      })
    ).toMatchObject({ ok: true })
    const partial = provider.reply.slice(0, -'reply.'.length)
    // The fixture holds the rest of its reply until the partial one is seen here.
    await vi.waitFor(
      () => {
        expect(errors).toEqual([])
        expect(text).toContain(partial)
      },
      { timeout: 30_000 }
    )
    await lane.guest(`touch ${quotePosixShell(install.ackPath)}`)
    await vi.waitFor(
      () => {
        expect(errors).toEqual([])
        expect(text).toContain(provider.reply)
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
      optionId: provider.optionId
    }
    expect(
      await lane.rpc('agentSession.respondToApproval', {
        ...answer,
        envelope: envelope(sessionId, 'agentSession.respondTo:approval', answer, fence)
      })
    ).toMatchObject({ ok: true })
    const readReport = async () =>
      ScriptedProviderReport.parse(
        JSON.parse(await lane.guest(`cat ${quotePosixShell(install.reportPath)}`))
      )
    await vi.waitFor(
      async () => expect(provider.answered(await readReport())).toEqual([provider.answer]),
      { timeout: 30_000 }
    )
    expect(
      await lane.rpc('agentSession.cancel', {
        envelope: envelope(sessionId, 'agentSession.cancel', {}, fence)
      })
    ).toMatchObject({ ok: true })
    await vi.waitFor(
      () => {
        expect(errors).toEqual([])
        expect(
          [...rows.values()].some(
            (row) =>
              row.body?.kind === 'turn' &&
              row.body.state === 'interrupted' &&
              row.body.outcome === 'cancellation'
          )
        ).toBe(true)
      },
      { timeout: 30_000 }
    )
    const report = await waitForProviderReport(
      lane,
      install.reportPath,
      ScriptedProviderReport,
      (written) => written.methods.includes(provider.stopMethod),
      provider.stopMethod
    )
    expect(report.cwd).toBe(cwd)
    // The guest's own runtime ran the guest install found on its login PATH: never a /mnt/ copy.
    expect(report.execPath).toMatch(/^\/(?!mnt\/)/u)
    expect(report.argv[0]).toBe(install.script)
    expect(report.argv).toEqual(expect.arrayContaining([...provider.argv]))
    expect(report.env).toMatchObject({
      ...('env' in provider ? provider.env : {}),
      ORCA_LANE_CLI_WRAPPER: install.cli,
      ORCA_AGENT_SESSION_ID: sessionId,
      ORCA_STRUCTURED_SESSION: '1',
      [provider.accountVar]: install.accountHome
    })
    return { sessionId, cwd, argv: report.argv, methods: report.methods }
  } finally {
    subscription.close()
    await lane.rpc('agentSession.close', { sessionId })
  }
}

type LaneWorkspace = { worktree: string; cwd: string }

/** Each scripted provider once; one workspace kind each keeps the lane short (Claude covers both). */
export async function exerciseScriptedProviderChats(
  lane: ChatLane,
  install: Record<WslScriptedProviderInstall['agent'], WslScriptedProviderInstall>,
  git: LaneWorkspace,
  folder: LaneWorkspace
) {
  const codex = await exerciseScriptedProviderChat(lane, install.codex, git.worktree, git.cwd)
  const grok = await exerciseScriptedProviderChat(lane, install.grok, folder.worktree, folder.cwd)
  const opencode = await exerciseScriptedProviderChat(lane, install.opencode, git.worktree, git.cwd)
  return { codex, grok, opencode }
}

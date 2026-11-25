import { forgetBotToolsEpoch } from '../../../bots/bot-tools-revision'
import { join } from 'node:path'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { BotOwnTool, BotToolServer } from '../../../../shared/bot-tools'
import type { Bot, BotAgent } from '../../../../shared/bot-types'
import {
  BotToolAdd,
  BotToolUpdate,
  BotToolFinishSignIn,
  BotToolTarget,
  BotToolsList,
  BotToolProblems
} from '../../../../shared/rpc-contract/bots-tools-params'
import { botHomeFolder } from '../../../bots/bot-home'
import { forgetBotToolCredentials } from '../../../bots/bot-tool-credentials'
import { revokeBotToolSignIns } from '../../../bots/tool-oauth/bot-tool-oauth-revoke'
import { botOwnTool, readBotToolServers } from '../../../bots/bot-tools-file'
import {
  addSortedBotTool,
  BOT_TOOL_SIGN_IN_NEEDS_UPDATE,
  connectOwnedBotTool,
  ownedBotToolSignInStatus,
  ownedSignInKey
} from '../../../bots/tool-oauth/bot-tool-owned-sign-in'
import { ClaudeMirrorScrubs } from '../../../bots/bot-tool-secret-scrub'
import { existsSync } from 'node:fs'
import { botToolRelay } from '../../../bots/tool-relay/bot-tool-relay'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import {
  botToolProblems,
  hasBotToolsCli,
  listBotTools,
  updateBotTool,
  type BotToolsFolder,
  type BotToolsHome
} from '../../../bots/bot-tools-host'
import { forgetBotTools, removeBotTool } from '../../../bots/bot-tools-removal'
import {
  botToolSignInStatus,
  connectBotTool,
  forgetBotToolSignIns,
  finishBotToolSignIn
} from '../../../bots/bot-tools-sign-in'
import {
  cancelBotToolHealthChecks,
  sharedBotToolHealthCheck
} from '../../../bots/bot-tool-health-checks'
import { parseBotToolPaste } from '../../../../shared/bot-tool-paste'
import { readBotToolDetails, resolveBotToolInput } from '../../../bots/bot-tool-details'
import { claudeConfigDirEnvPatch } from '../../../claude/structured/launch/claude-config-dir-pin'
import { structuredAgentHostLaunchSources } from '../../agent-session/launch/structured-agent-launch-support'
import { structuredAgentRuntimeMetadata } from '../../agent-session/installation/structured-agent-runtime-metadata'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { appendOrcaChatCard } from '../../orca-chat-card'
import { defineMethod, InvalidArgumentError } from '../core'
import { refuseFromLook, targetBot } from './bots-tools-target'

const botToolSignInFolder = (botId: string): string =>
  join(getProfileUserDataPath(), 'bot-tool-sign-in', botId)

/** The bot's tools on this host, with the agent CLI and account its next turn runs for Claude Code and Codex. */
export async function botToolsHome(runtime: OrcaRuntimeService, bot: Bot): Promise<BotToolsHome> {
  const agent = bot.agent
  return toolsHomeFor(runtime, agent, {
    botId: bot.id,
    folder: botHomeFolder(bot),
    signInFolder: botToolSignInFolder(bot.id),
    otherBotFolders: runtime.bots
      .list()
      .filter((other) => other.id !== bot.id && other.agent === agent)
      .map((other) => botHomeFolder(other))
  })
}

/** A tools folder with the agent CLI and account a new chat runs for Claude Code and Codex. */
export async function toolsHomeFor(
  runtime: OrcaRuntimeService,
  agent: BotAgent,
  folder: BotToolsFolder
): Promise<BotToolsHome> {
  if (agent !== 'claude' && agent !== 'codex') {
    return { ...folder, agent }
  }
  const release = new AbortController()
  try {
    const sources = await structuredAgentHostLaunchSources(agent, runtime, release.signal)
    const program = structuredAgentRuntimeMetadata(agent)?.chatProgram
    if (!program) {
      throw new InvalidArgumentError(`${agent} isn't available on this computer.`)
    }
    const { command, prefixArgs, env } = await program.resolve(sources.env, sources.commandSettings)
    const home = requireLegacyAgentSessionAccountHome(sources.accountHome).path
    // As a chat's launch pins it: only a non-default home; the CLI then reads the config dir its env names.
    const cliEnv = agent === 'claude' ? { ...env, ...claudeConfigDirEnvPatch(home, { env }) } : env
    return {
      ...folder,
      agent,
      command,
      prefixArgs: [...prefixArgs],
      env: cliEnv,
      accountHome: agent === 'claude' ? cliEnv.CLAUDE_CONFIG_DIR?.trim() || null : home
    }
  } finally {
    release.abort()
  }
}

const scrubs = new WeakMap<OrcaRuntimeService, ClaudeMirrorScrubs>()

/**
 * Moves saved values an older Orca left in the bot's tools file, and in the Claude config of the
 * account its CLI runs on now, to the credential store; throws when that can't be done.
 */
export async function scrubBotToolSecrets(runtime: OrcaRuntimeService, bot: Bot): Promise<void> {
  await readBotToolServers(botHomeFolder(bot))
  if (bot.agent !== 'claude' || !existsSync(botToolSignInFolder(bot.id))) {
    return
  }
  let state = scrubs.get(runtime)
  if (!state) {
    state = new ClaudeMirrorScrubs()
    scrubs.set(runtime, state)
  }
  const home = await botToolsHome(runtime, bot)
  if (hasBotToolsCli(home)) {
    await state.ensure(home)
  }
}

/** Signs a bot's tools out before the bot is deleted; a CLI that can't run doesn't stop the delete. */
export async function forgetDeletedBotTools(runtime: OrcaRuntimeService, bot: Bot): Promise<void> {
  forgetBotToolSignIns(bot.id)
  forgetBotToolsEpoch(botHomeFolder(bot))
  await botToolsHome(runtime, bot)
    .then(forgetBotTools)
    .catch((error: unknown) =>
      console.warn("[bots] signing out a deleted bot's tools failed:", error)
    )
  // Whether or not its CLI could run, the bot's token and saved values go with it.
  botToolRelay.revoke(bot.id)
  revokeBotToolSignIns(forgetBotToolCredentials(botHomeFolder(bot)))
}

/** A pasted URL, or the command line that starts a server; its name from the URL or package. */
export function botToolServerOf(source: string, name?: string): BotToolServer {
  const parsed = parseBotToolPaste(source, process.platform)
  return { ...parsed, name: name ?? parsed.name }
}

export const BOT_TOOLS_METHODS = [
  defineMethod({
    name: 'bots.tools.list',
    permission: 'workspace',
    params: BotToolsList,
    handler: async (params, context) => {
      const bot = targetBot(params, context)
      return await listBotTools(await botToolsHome(context.runtime, bot))
    }
  }),
  defineMethod({
    name: 'bots.tools.problems',
    permission: 'workspace',
    params: BotToolProblems,
    handler: async (params, context) => {
      const bot = targetBot(params, context)
      const remote = params.scope === 'remote'
      const problems = await sharedBotToolHealthCheck(
        bot.id,
        `${bot.agent}\0${remote ? 'remote' : 'all'}`,
        async (signal) => {
          await scrubBotToolSecrets(context.runtime, bot)
          return botToolProblems(await botToolsHome(context.runtime, bot), { remote, signal })
        }
      )
      return { problems }
    }
  }),
  defineMethod({
    name: 'bots.tools.cancelProblems',
    permission: 'workspace',
    params: BotToolsList,
    handler: (params, context) => {
      cancelBotToolHealthChecks(targetBot(params, context).id)
      return { cancelled: true }
    }
  }),
  defineMethod({
    name: 'bots.tools.add',
    permission: 'workspace',
    params: BotToolAdd,
    handler: async (params, context): Promise<{ tool: BotOwnTool }> => {
      refuseFromLook(params, context)
      const bot = targetBot(params, context)
      const given =
        'config' in params
          ? resolveBotToolInput(params.config)
          : botToolServerOf(params.source, params.name)
      const cli = await botToolsHome(context.runtime, bot)
      const tool = await addSortedBotTool(cli, given, context.signal)
      // Added from the bot's chat: the chat shows it, with its sign-in and a way to remove it.
      const caller = context.pairedDeviceId === undefined ? params.callerSessionId : undefined
      if (caller) {
        const added = { name: tool.name, detail: tool.detail, remote: tool.remote }
        const card = {
          kind: 'tool-added' as const,
          botId: bot.id,
          tool: added,
          addedAt: Date.now()
        }
        appendOrcaChatCard(caller, card, 'showing an added tool in its chat')
      }
      return { tool }
    }
  }),
  defineMethod({
    name: 'bots.tools.context',
    permission: 'workspace',
    params: BotToolsList,
    handler: async (params, context) => {
      const cli = await botToolsHome(context.runtime, targetBot(params, context))
      return { folder: cli.folder, platform: process.platform, agent: cli.agent }
    }
  }),
  defineMethod({
    name: 'bots.tools.details',
    permission: 'workspace',
    params: BotToolTarget,
    handler: async (params, context) =>
      readBotToolDetails(
        (await botToolsHome(context.runtime, targetBot(params, context))).folder,
        params.name
      )
  }),
  defineMethod({
    name: 'bots.tools.update',
    permission: 'workspace',
    params: BotToolUpdate,
    handler: async (params, context) => {
      refuseFromLook(params, context)
      const bot = targetBot(params, context)
      const cli = await botToolsHome(context.runtime, bot)
      const server = await updateBotTool(cli, params.name, params.version, params.config)
      forgetBotToolSignIns(bot.id, params.name)
      return { tool: botOwnTool(server, cli.folder) }
    }
  }),
  defineMethod({
    name: 'bots.tools.remove',
    permission: 'workspace',
    params: BotToolTarget,
    handler: async (params, context) => {
      refuseFromLook(params, context)
      const bot = targetBot(params, context)
      await removeBotTool(await botToolsHome(context.runtime, bot), params.name)
      forgetBotToolSignIns(bot.id, params.name)
      return { removed: params.name }
    }
  }),
  defineMethod({
    name: 'bots.tools.connect',
    permission: 'workspace',
    params: BotToolTarget,
    handler: async (params, context) => {
      refuseFromLook(params, context)
      const bot = targetBot(params, context)
      const owned = await connectOwnedBotTool(botHomeFolder(bot), params.name, context)
      return (
        owned ??
        (await connectBotTool(bot.id, params.name, () => botToolsHome(context.runtime, bot)))
      )
    }
  }),
  defineMethod({
    name: 'bots.tools.finishSignIn',
    permission: 'workspace',
    params: BotToolFinishSignIn,
    handler: async (params, context) => {
      refuseFromLook(params, context)
      const bot = targetBot(params, context)
      if (await ownedSignInKey(botHomeFolder(bot), params.name)) {
        throw new Error(BOT_TOOL_SIGN_IN_NEEDS_UPDATE)
      }
      await finishBotToolSignIn(
        await botToolsHome(context.runtime, bot),
        params.name,
        params.address
      )
      return { finished: params.name }
    }
  }),
  defineMethod({
    // What a Connect is waiting on; read from memory and the tools file, so a client can ask often.
    name: 'bots.tools.signInStatus',
    permission: 'workspace',
    params: BotToolTarget,
    handler: async (params, context) => {
      const bot = targetBot(params, context)
      return (
        (await ownedBotToolSignInStatus(botHomeFolder(bot), params.name)) ?? {
          status: botToolSignInStatus(bot.id, params.name)
        }
      )
    }
  })
]

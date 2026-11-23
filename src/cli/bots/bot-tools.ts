// `orca bot tools`: a bot's own tools (MCP servers) beside the ones it gets from its owner's agent.
import { createInterface } from 'node:readline'
import { quoteCliCommandArgument } from '../arguments/shell-command-quote'
import { describeRemoteServerSelection } from '../hosts/remote-server-selection'
import { BOTS_TOOLS_OWNED_SIGN_IN_RUNTIME_CAPABILITY } from '../../shared/bot-runtime-capabilities'
import type { BotOwnTool, BotToolProblem, BotTools } from '../../shared/bot-tools'
import {
  botToolSignInFailureWords,
  botToolSignInPastedQuery,
  type BotToolSignInAttemptView
} from '../../shared/bot-tool-sign-in'
import type { HostAccountSignInPhase } from '../../shared/agent-accounts/host-account-sign-in-types'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { callerChat } from '../automations/automation-caller-chat'
import { type AuthInterruptSource, processInterrupts } from '../accounts/auth-interrupts'
import { callBots, findBot } from './bot'
import { assertHostCapability, driveHostSignInAs } from '../accounts/host-sign-in-driver'

const AGENT_NAMES: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex' }

async function target(context: Pick<HandlerContext, 'flags' | 'client'>) {
  const selector = getOptionalStringFlag(context.flags, 'bot')
  return {
    ...callerChat(),
    ...(selector ? { botId: (await findBot(context.client, selector)).id } : {})
  }
}

const problemText = (problem: BotToolProblem): string =>
  problem.kind === 'sign-in'
    ? 'needs sign-in: `orca bot tools connect <name>`'
    : problem.kind === 'unconfirmed'
      ? 'native connection not confirmed'
      : `won't start${problem.detail ? `: ${problem.detail}` : ''}`

export function formatBotTools(
  tools: BotTools,
  problems: Readonly<Record<string, BotToolProblem>> = {}
): string {
  const own = tools.own.map((tool: BotOwnTool) => {
    const problem = problems[tool.name]
    return `${tool.name}  ${tool.detail}${problem ? `  (${problemText(problem)})` : ''}`
  })
  // Only Claude Code's and Codex's own config is read for the tools a bot inherits.
  const agent = AGENT_NAMES[tools.agent]
  return [
    ...(own.length > 0 ? own : ['No tools of its own yet.']),
    ...(agent
      ? [
          `${tools.inherited.length} more from your ${agent}${
            tools.inherited.length > 0
              ? `: ${tools.inherited.map((tool) => tool.name).join(', ')}`
              : ''
          }`
        ]
      : [])
  ].join('\n')
}

type HostSignIn = {
  flowId: string
  revision: number
  phase: HostAccountSignInPhase
  error?: string
  view: BotToolSignInAttemptView
}

/** The host's attempt in the driver's words; a failure is said as the host would. */
function hostSignIn(view: BotToolSignInAttemptView, host: string): HostSignIn {
  const phase: HostAccountSignInPhase =
    view.state === 'done'
      ? 'signedIn'
      : view.state === 'failed'
        ? view.code === 'cancelled'
          ? 'cancelled'
          : 'failed'
        : 'waiting'
  return {
    flowId: view.flowId,
    revision: view.revision,
    phase,
    ...(view.state === 'failed' ? { error: botToolSignInFailureWords(view.code, host) } : {}),
    view
  }
}

/** Sends the first pasted address that is this sign-in's; a refused one prints why and keeps listening. */
function relayPastedAddresses(
  ctx: HandlerContext,
  waiting: Extract<BotToolSignInAttemptView, { state: 'waiting' }>,
  input: NodeJS.ReadableStream
): () => void {
  if (!input.readable) {
    return () => {}
  }
  const lines = createInterface({ input, terminal: false })
  let sent = false
  lines.on('line', (line) => {
    if (sent || !line.trim()) {
      return
    }
    const query = botToolSignInPastedQuery(line, waiting)
    if (query === null) {
      process.stderr.write(
        'That address isn’t from this sign-in. Paste the address you landed on.\n'
      )
      return
    }
    sent = true
    process.stderr.write('Finishing sign-in…\n')
    void ctx.client
      .call('bots.tools.signIn.finish', { flowId: waiting.flowId, query })
      .catch((error: unknown) => {
        sent = false
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      })
  })
  return () => lines.close()
}

/**
 * Signs a paired server's bot in to an app Orca signs in to: the server runs it, this terminal shows
 * the page, and the address the browser lands on is pasted back here.
 */
export async function runRemoteBotToolSignIn(
  ctx: HandlerContext,
  target: { botId?: string },
  name: string,
  interrupts: AuthInterruptSource = processInterrupts,
  input: NodeJS.ReadableStream = process.stdin
): Promise<void> {
  const status = await ctx.client.call<{ machineName?: string }>('status.get')
  const host = status.result.machineName ?? 'the server'
  await assertHostCapability(
    ctx,
    BOTS_TOOLS_OWNED_SIGN_IN_RUNTIME_CAPABILITY,
    `Update Orca on ${host} to sign in to apps.`
  )
  const started = await ctx.client.call<BotToolSignInAttemptView>('bots.tools.signIn.start', {
    ...target,
    name,
    mode: 'paste'
  })
  const done = await driveHostSignInAs(ctx, {
    flow: hostSignIn(started.result, host),
    read: (answer: BotToolSignInAttemptView) => hostSignIn(answer, host),
    methods: { wait: 'bots.tools.signIn.wait', cancel: 'bots.tools.signIn.cancel' },
    interrupts,
    onWaiting: async ({ view }) => {
      if (view.state !== 'waiting') {
        return
      }
      process.stderr.write(
        [
          `Open this page in a browser on any device and sign in to ${name}:`,
          '',
          `  ${view.authorizationUrl}`,
          '',
          'Then paste the address you landed on here.',
          'Waiting… (Ctrl+C to cancel)',
          ''
        ].join('\n')
      )
      return relayPastedAddresses(ctx, view, input)
    },
    interrupted: {
      finished: `Interrupted, but ${name} had already signed in. See it with \`orca bot tools\`.`,
      unconfirmed: `Interrupted, and ${host} didn't confirm the sign-in stopped. Run \`orca bot tools\` to check.`
    }
  })
  if (done.phase !== 'signedIn') {
    throw new RuntimeClientError(
      'sign_in_failed',
      done.error ?? (done.phase === 'cancelled' ? 'The sign-in was cancelled.' : 'Sign-in failed.')
    )
  }
  printResult({ ...started, result: { signedIn: name } }, ctx.json, () => `Signed in to ${name}.`)
}

/** Whether Orca signs the bot in to the tool itself, as the host lists it. */
async function signsInItself(
  ctx: HandlerContext,
  target: { botId?: string },
  name: string
): Promise<boolean> {
  const { result } = await callBots<BotTools>(ctx.client, 'bots.tools.list', target)
  return 'own' in result && result.own.some((tool) => tool.name === name && tool.signIn)
}

export const BOT_TOOLS_HANDLERS: Record<string, CommandHandler> = {
  'bot tools': async ({ flags, client, json }) => {
    const params = await target({ flags, client })
    const listed = await callBots<BotTools>(client, 'bots.tools.list', params)
    const { result: checked } = await callBots<{ problems: Record<string, BotToolProblem> }>(
      client,
      'bots.tools.problems',
      params
    )
    printResult(
      { ...listed, result: { ...listed.result, problems: checked.problems } },
      json,
      (value) => formatBotTools(value, value.problems)
    )
  },
  'bot tools add': async ({ flags, client, json }) => {
    const name = getOptionalStringFlag(flags, 'name')
    const result = await callBots<{ tool: BotOwnTool }>(client, 'bots.tools.add', {
      ...(await target({ flags, client })),
      source: getRequiredStringFlag(flags, 'source'),
      ...(name ? { name } : {})
    })
    printResult(result, json, ({ tool }) =>
      tool.remote
        ? `Added ${tool.name}. If it needs a sign-in: \`orca bot tools connect ${tool.name}\`.`
        : `Added ${tool.name}.`
    )
  },
  'bot tools rm': async ({ flags, client, json }) => {
    const result = await callBots<{ removed: string }>(client, 'bots.tools.remove', {
      ...(await target({ flags, client })),
      name: getRequiredStringFlag(flags, 'name')
    })
    printResult(result, json, ({ removed }) => `Removed ${removed}.`)
  },
  'bot tools connect': async (ctx) => {
    const { flags, client, json } = ctx
    const name = getRequiredStringFlag(flags, 'name')
    const finish = getOptionalStringFlag(flags, 'finish')
    // A paired server signs in for this device; its page's address is pasted back while this waits.
    if (client.isRemote) {
      const bot = await target({ flags, client })
      if (await signsInItself(ctx, bot, name)) {
        if (finish) {
          const selector = getOptionalStringFlag(flags, 'bot')
          const again = [
            `orca bot tools connect ${quoteCliCommandArgument(name)}`,
            describeRemoteServerSelection(flags)?.flag,
            selector && `--bot ${quoteCliCommandArgument(selector)}`
          ]
            .filter(Boolean)
            .join(' ')
          throw new RuntimeClientError(
            'invalid_argument',
            `Run \`${again}\` and paste the address when it asks.`
          )
        }
        await runRemoteBotToolSignIn(ctx, bot, name)
        return
      }
    }
    if (finish) {
      const finished = await callBots<{ finished: string }>(client, 'bots.tools.finishSignIn', {
        ...(await target({ flags, client })),
        name,
        address: finish
      })
      printResult(finished, json, () => `Signed in to ${name}.`)
      return
    }
    const result = await callBots<{ authorizationUrl: string | null }>(
      client,
      'bots.tools.connect',
      {
        ...(await target({ flags, client })),
        name
      }
    )
    printResult(result, json, ({ authorizationUrl }) =>
      authorizationUrl
        ? `Ask your owner to open this page and sign in to ${name}:\n${authorizationUrl}\nIf their browser then shows a page that can't load, finish with \`orca bot tools connect ${name} --finish <that address>\`.`
        : `The sign-in page for ${name} opened in the browser.`
    )
  }
}

import type { Bot } from '../../shared/bot-types'
import type { BotCreateParams } from '../../shared/rpc-contract/bots-params'
import { BOT_ORCA_CLI } from './bot-preamble'
import { LOOK_AROUND_DEFAULTS } from '../../shared/bots/bot-look-around'

export const commanderBotDefaults = {
  systemRole: 'commander',
  firstRun: undefined,
  lookAround: { ...LOOK_AROUND_DEFAULTS, on: false },
  tidyUp: { on: false }
} as const

function commanderBotName(bots: readonly Bot[]): string {
  const names = new Set(bots.map((bot) => bot.name.toLowerCase()))
  let name = 'Commander'
  for (let n = 2; names.has(name.toLowerCase()); n++) {
    name = `Commander ${n}`
  }
  return name
}

/** Called in the bot controller's mutation queue, shared with rename, delete, and chat creation. */
export async function findOrCreateCommander<Store extends { getBots: () => Bot[] }>(
  currentStore: () => Store,
  chooseAgent: () => Promise<Bot['agent']>,
  persist: (store: Store) => Promise<void>,
  create: (store: Store, input: BotCreateParams) => Promise<Bot>
): Promise<Bot> {
  const store = currentStore()
  const existing = store.getBots().find((bot) => bot.systemRole === 'commander')
  if (existing) {
    // A previous save may have reached memory before its immediate disk flush failed.
    await persist(store)
    return existing
  }
  const agent = await chooseAgent()
  if (store !== currentStore()) {
    throw new Error('The active profile changed. Reopen Commander.')
  }
  return create(store, { name: commanderBotName(store.getBots()), agent })
}

export const commanderSoul = `# Commander

Coordinate the owner's goals across their Orca projects and workers. Keep the owner informed about outcomes, blockers, and decisions in this conversation.

For a status question, start with ${BOT_ORCA_CLI} orchestration briefing --json for a compact report of Runs, task counts and decisions on the current runtime. Use ${BOT_ORCA_CLI} host list to discover paired hosts, then ${BOT_ORCA_CLI} orchestration briefing --environment <id> --json for each relevant runtime. Follow the returned cursor when more Runs are needed. Use ${BOT_ORCA_CLI} project setups for project registrations and ${BOT_ORCA_CLI} orchestration gate-list --run <id> --status pending for decision details. Verify state before reporting completion and name any unavailable hosts.

For a new goal, look for an existing Run before creating one. Use ${BOT_ORCA_CLI} orchestration run-create, task-create and worker-start to supervise work on the intended project and host. Use the installed CLI help for required arguments. When the owner configured a project Memory grant, pass --commander-project and --commander-task-kind to worker-start to apply applicable guidelines and model routing. Track Run, task, and dispatch IDs in your memory so you can resume. End the turn while workers run and handle their messages when Orca wakes you.

Summarize changes together. Request a decision when a blocker needs the owner. Follow the owner's project guidelines, budgets, and permission settings. Reuse existing results before dispatching more work. Report which actions succeeded and which remain pending.
`

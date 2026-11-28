// A Codex bot's tools checked in one app-server session: Codex's loaded config names the ones it
// can't add, and a thread with the rest says how each of those is.
import { botFailure, botFailureEnglish } from '../../shared/bots/bot-failure-copy'
import type { BotToolProblem, BotToolServer } from '../../shared/bot-tools'
import { redactBotToolProblems } from './bot-tool-redaction'
import { cliWithLaunchTools, withRelayProblems } from './bot-launch-tools'
import { withLoopbackNoProxy } from '../mcp-servers/session-mcp-tools'
import { CLI_TIMEOUT_MS, codexSession } from './bot-tools-cli'
import { codexTakenToolProblem, codexThread, settledCodexToolProblems } from './bot-tools-codex'
import { codexLoadedServers, codexRefusedOf, codexServerKindsOf } from './bot-tools-codex-conflicts'
import type { BotToolsCli } from './bot-tools-host'

type Problems = Record<string, BotToolProblem>

/** A tool the check couldn't finish for: not known to work, and not known not to. */
const notFinished = (names: Iterable<string>): Problems =>
  Object.fromEntries(
    [...names].map((name) => [
      name,
      { kind: 'unconfirmed', detail: botFailureEnglish(botFailure('toolCodexCheckFailed')) }
    ])
  )

const conflicts = (names: Iterable<string>): Problems =>
  Object.fromEntries([...names].map((name) => [name, codexTakenToolProblem(name)]))

/** Of `candidates`, the names `startable` doesn't have: the tools Orca signed in to. */
const signedInNames = (
  candidates: readonly BotToolServer[],
  startable: readonly BotToolServer[]
): string[] => candidates.filter((server) => !startable.includes(server)).map(({ name }) => name)

/** Ends the opens: none of the tools is left to check, or a remote check can't stay command-free. */
class StopOpening extends Error {}

export type CodexCheckTools = {
  /** The bot's tools Codex may add. */
  candidates: readonly BotToolServer[]
  /** Of them, the ones a thread starts (not signed in by Orca). */
  startable: readonly BotToolServer[]
  /** Already known to fail (the account's config.toml has the name): kept whatever happens. */
  taken: Problems
  ownerStdioNames: ReadonlySet<string>
}

/**
 * Problems of the bot's tools. What the check learns for certain is kept through any failure
 * after it (a conflict, a tool's last definite status), and the tools it couldn't finish say so;
 * only `signal` throws it away, so a cancelled check publishes nothing. The thread starts only the
 * bot's servers: every other one the config loads is turned off in each open, and a grant is made
 * only once a thread will open. `remote` starts no command, so nothing opens when the config can't
 * be read, and the opens stop once Codex shows a layer the read didn't.
 */
export async function codexBotToolProblems(
  cli: BotToolsCli,
  { candidates, startable, taken, ownerStdioNames }: CodexCheckTools,
  { remote, signal }: { remote: boolean; signal?: AbortSignal }
): Promise<Problems> {
  const known = new Set<string>()
  const seen = new Map<string, BotToolProblem | null>()
  let read = false
  const statuses = (): Map<string, BotToolProblem> =>
    new Map(
      [...seen].flatMap(([name, problem]): [string, BotToolProblem][] =>
        problem ? [[name, problem]] : []
      )
    )
  /** What is known now, and the rest as not finished. */
  const sofar = (): Problems => {
    const unsure = (read ? startable : candidates)
      .map(({ name }) => name)
      .filter((name) => !known.has(name) && !seen.has(name))
    return {
      ...notFinished(unsure),
      ...withRelayProblems(cli, startable, redactBotToolProblems(statuses(), startable)),
      ...conflicts(known),
      ...taken
    }
  }
  // The grant comes after the app-server starts, so it reaches loopback (a relayed or shared
  // server) whatever the grant turns out to relay; Codex sends loopback to a proxy unless told not to.
  const session = { ...cli, env: withLoopbackNoProxy(cli.env) }
  try {
    return await codexSession(
      session,
      CLI_TIMEOUT_MS,
      async (rpc) => {
        const added = codexServerKindsOf(candidates)
        const loaded = await codexLoadedServers(rpc, cli.folder)
        if (!loaded && (remote || startable.length === 0)) {
          // Without the config, neither a signed-in tool's name nor a command-free thread is known.
          return sofar()
        }
        read = loaded !== null
        for (const name of loaded ? codexRefusedOf(loaded, added) : []) {
          known.add(name)
        }
        const open = startable.filter((server) => !known.has(server.name))
        if (open.length === 0) {
          return sofar()
        }
        // The grant (and any relay listener) only now that a thread opens, for its servers only.
        const launch = await cliWithLaunchTools(cli, open)
        const opened = await codexThread(rpc, launch.cli, launch.tools, ownerStdioNames, {
          refused: [],
          onRefused: (name) => {
            known.add(name)
            // A remote check can't promise no command from a layer the read missed.
            if (remote || open.every((server) => known.has(server.name))) {
              throw new StopOpening()
            }
          },
          // The check reads no other server, and a remote one runs no command.
          ...(loaded ? { onlySent: [...loaded.keys()] } : {})
        }).catch((error: unknown) => {
          if (error instanceof StopOpening) {
            return null
          }
          throw error
        })
        if (!opened) {
          return sofar()
        }
        // The status under a left-out name is the owner's own server's, not the bot's.
        const checked = open
          .map(({ name }) => name)
          .filter((name) => !opened.leftOut.includes(name))
        const problems = await settledCodexToolProblems(rpc, opened.threadId, checked, signal, seen)
        return {
          // Without the config, a signed-in tool's name isn't known to be free.
          ...notFinished(read ? [] : signedInNames(candidates, startable)),
          ...withRelayProblems(cli, startable, redactBotToolProblems(problems, startable)),
          ...conflicts(known),
          ...taken
        }
      },
      signal
    )
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    // Nothing was learned for certain: the check failed as a whole, as before.
    if (known.size === 0 && seen.size === 0 && Object.keys(taken).length === 0) {
      throw error
    }
    return sofar()
  }
}

// The owner's agent-slack on the host, as a scenario that puts it there sees it: `search messages`
// as the owner (bot-automation-eval-slack.ts searchSlackAsOwner), its options read as the real
// CLI's --help lists them; only --user, --channel and --limit narrow it, so it never hides what the
// real one would show. Elsewhere it isn't here, as their other tools aren't.
import { readFileSync } from 'node:fs'
import type { EvalHostState } from './bot-automation-eval-host'
import { searchSlackAsOwner } from './bot-automation-eval-slack-search'

const state: EvalHostState = JSON.parse(readFileSync(process.env.ORCA_EVAL_STATE ?? '', 'utf8'))
const args = process.argv.slice(2)
if (!state.ownerSlack) {
  process.stderr.write('agent-slack is not available here.\n')
  process.exit(127)
}
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    'Usage: agent-slack search messages [options] <query>\n\nOptions: --channel <channel...> --user <user> --limit <n> --resolve-users\n'
  )
  process.exit(0)
}
if (args[0] !== 'search' || args[1] !== 'messages') {
  process.stderr.write('agent-slack: only `agent-slack search messages <query>` works here.\n')
  process.exit(2)
}
// --channel takes several names and repeats; the two flags below take no value; any other takes one.
const BOOLEANS = new Set(['--resolve-users', '--refresh-users'])
const words: string[] = []
const channels: string[] = []
const options = new Map<string, string>()
const rest = args.slice(2)
for (let i = 0; i < rest.length; i++) {
  const [flag, inline] = rest[i]!.split(/=(.*)/s)
  if (!flag!.startsWith('-')) {
    words.push(rest[i]!)
  } else if (flag === '--channel') {
    const values = inline === undefined ? [] : [inline]
    while (inline === undefined && rest[i + 1] !== undefined && !rest[i + 1]!.startsWith('-')) {
      values.push(rest[++i]!)
    }
    channels.push(...values)
  } else if (!BOOLEANS.has(flag!)) {
    options.set(flag!, inline ?? rest[++i] ?? '')
  }
}
const user = options.get('--user')
const limit = Number(options.get('--limit') ?? 20)
const messages = searchSlackAsOwner(words.join(' '), {
  ...(user ? { user } : {}),
  ...(channels.length ? { channels } : {})
}).slice(0, limit > 0 ? limit : undefined)
process.stdout.write(`${JSON.stringify({ messages }, null, 2)}\n`)

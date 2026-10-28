import { runOperatorCli } from './operator-cli.js'
import { runDiscordOperator } from './discord-operator.js'

// pnpm --filter @orca-cloud/connector discord-operator <command>, with the service's database env.
await runOperatorCli('orca-connector-discord-operator', (database) =>
  runDiscordOperator(process.argv.slice(2), { database, now: Date.now })
)

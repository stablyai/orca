import { text } from 'node:stream/consumers'
import { runOperatorCli } from './operator-cli.js'
import { decodeSlackTokenKey } from './slack-config.js'
import { runSlackOperator } from './slack-operator.js'

// pnpm --filter @orca-cloud/connector slack-operator <command>, with the service's database env.
const tokenKey = process.env.ORCA_CONNECTOR_SLACK_TOKEN_KEY
await runOperatorCli('orca-connector-slack-operator', (database) =>
  runSlackOperator(process.argv.slice(2), {
    database,
    ...(tokenKey ? { tokenKey: decodeSlackTokenKey(tokenKey) } : {}),
    readSecret: () => text(process.stdin),
    now: Date.now
  })
)

const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const home = process.env.CODEX_HOME
const account = () =>
  JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).tokens.account_id.replace(
    'acct-',
    ''
  )
if (args.includes('--version')) {
  console.log(process.env.ORCA_TEST_CODEX_VERSION || 'codex-cli 0.166.0')
} else if (args[0] === 'debug') {
  console.log(
    JSON.stringify({
      models: [
        {
          slug: 'gpt-5.6-terra',
          display_name: 'Terra',
          supported_reasoning_levels: [{ effort: 'low' }]
        }
      ]
    })
  )
} else if (args.includes('app-server')) {
  require('node:readline')
    .createInterface({ input: process.stdin })
    .on('line', (line) => {
      const message = JSON.parse(line)
      if (message.id == null) {
        return
      }
      const result =
        message.method === 'account/rateLimits/read'
          ? {
              rateLimits: {
                primary: {
                  usedPercent: account() === 'a' ? 100 : 10,
                  windowDurationMins: 300,
                  resetsAt: Math.floor(Date.now() / 1000) + 3600
                },
                secondary: {
                  usedPercent: 20,
                  windowDurationMins: 10080,
                  resetsAt: Math.floor(Date.now() / 1000) + 86400
                },
                credits: { hasCredits: false, unlimited: false, balance: '0' }
              },
              rateLimitResetCredits: { availableCount: 0 }
            }
          : {}
      console.log(JSON.stringify({ id: message.id, result }))
    })
} else {
  let input = ''
  process.stdin.on('data', (chunk) => {
    input += chunk.toString('utf8')
  })
  process.stdin.on('end', () => {
    const id = account()
    fs.appendFileSync(
      process.env.ORCA_TEST_SUBSCRIPTIONS_LOG,
      `${JSON.stringify({ account: id, home, args, input })}\n`
    )
    if (id === 'a') {
      if (args.includes('--json')) {
        process.stdout.write(fs.readFileSync(process.env.ORCA_TEST_QUOTA_FIXTURE, 'utf8'))
      } else {
        console.error('Provider refusal')
      }
      process.exitCode = 1
    } else {
      if (args.includes('--json')) {
        console.log(
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'fix-auth' }
          })
        )
        console.log(JSON.stringify({ type: 'turn.completed', usage: {} }))
      } else {
        console.log('fix-auth')
      }
    }
  })
}

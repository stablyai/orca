const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const v2 = path.basename(process.argv[1]) === 'opencode2'
if (args.includes('--version')) {
  console.log(v2 ? '2.0.0' : '1.19.4')
} else if (args[0] === 'models') {
  console.log('opencode-go/fixture-model')
} else {
  let input = ''
  process.stdin.on('data', (chunk) => {
    input += chunk.toString('utf8')
  })
  process.stdin.on('end', () => {
    let account
    if (v2) {
      const Database = process.versions.bun
        ? require('bun:sqlite').Database
        : require('node:sqlite').DatabaseSync
      const database = new Database(path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'))
      account = JSON.parse(
        database
          .prepare(
            "SELECT value FROM credential WHERE integration_id = 'opencode-go' AND active = 1"
          )
          .get().value
      ).key
      database.close()
    } else {
      const auth = JSON.parse(
        fs.readFileSync(path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8')
      )
      account = auth['opencode-go'].key
    }
    fs.appendFileSync(
      process.env.ORCA_TEST_SUBSCRIPTIONS_LOG,
      `${JSON.stringify({ account, home: process.env.XDG_DATA_HOME, args, input })}\n`
    )
    if (account === 'a') {
      process.stdout.write(fs.readFileSync(process.env.ORCA_TEST_QUOTA_FIXTURE, 'utf8'))
      process.exitCode = 1
    } else {
      console.log(JSON.stringify({ type: 'step_start', part: { id: 'step' } }))
      console.log(JSON.stringify({ type: 'text', part: { id: 'answer', text: 'fix-auth' } }))
    }
  })
}

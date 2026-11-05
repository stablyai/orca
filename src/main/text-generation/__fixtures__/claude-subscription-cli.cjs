const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log(process.env.ORCA_TEST_CLAUDE_VERSION || '2.1.317 (Claude Code)')
  process.exit(0)
}
let input = ''
process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8')
})
process.stdin.on('end', async () => {
  const home = process.env.CLAUDE_CONFIG_DIR
  const account = JSON.parse(fs.readFileSync(path.join(home, '.credentials.json'), 'utf8'))
    .claudeAiOauth.accessToken
  if (args.includes('--input-format')) {
    console.log(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          response: {
            models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' }]
          }
        }
      })
    )
    return
  }
  fs.appendFileSync(
    process.env.ORCA_TEST_SUBSCRIPTIONS_LOG,
    `${JSON.stringify({
      account,
      home,
      args,
      input,
      pointer: process.env.ORCA_CLAUDE_PROFILE_POINTER
    })}\n`
  )
  const behavior = JSON.parse(
    fs.readFileSync(process.env.ORCA_TEST_SUBSCRIPTIONS_BEHAVIOR, 'utf8')
  )[account]
  const structured = args.includes('stream-json')
  if (behavior === 'held-success') {
    console.error('ORCA_TEST_SUBSCRIPTIONS_HELD_READY')
    const gate = process.env.ORCA_TEST_SUBSCRIPTIONS_GATE
    await new Promise((resolve) => {
      const check = () => {
        if (fs.existsSync(gate)) {
          fs.unwatchFile(gate, check)
          resolve()
        }
      }
      fs.watchFile(gate, { interval: 10 }, check)
      check()
    })
  }
  if (behavior === 'success' || behavior === 'held-success') {
    console.log(
      structured
        ? JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: process.env.ORCA_TEST_SUBSCRIPTIONS_OUTPUT || 'fix-auth'
          })
        : process.env.ORCA_TEST_SUBSCRIPTIONS_OUTPUT || 'fix-auth'
    )
    return
  }
  if (structured) {
    console.log(
      JSON.stringify({
        type: 'assistant',
        error: behavior === 'quota' ? 'rate_limit' : 'authentication_failed',
        api_error: behavior === 'quota' ? 'usage_limit_reached' : 'authentication_failed',
        parent_tool_use_id: null
      })
    )
    console.log(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Provider refusal'
      })
    )
  } else {
    console.error('Provider refusal')
  }
  process.exitCode = 1
})

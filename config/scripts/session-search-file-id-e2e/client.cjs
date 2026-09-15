const { connect } = require('node:net')

const assert = require('node:assert/strict')

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')

const socket = connect(process.argv[2])

let buffer = ''

socket.setEncoding('utf8')

socket.setTimeout(10_000, () => socket.destroy(new Error('RPC client timeout')))

socket.on('connect', () =>
  socket.write(
    `${JSON.stringify({
      id: 'file-id-query',
      authToken: 'isolated-fixture',
      method: 'aiVault.searchSessions',
      params: JSON.parse(process.argv[3])
    })}\n`
  )
)

socket.on('data', (chunk) => {
  buffer += String(chunk)
  const newline = buffer.indexOf('\n')

  if (newline === -1) {
    return
  }

  console.log(JSON.stringify({ pid: process.pid, response: JSON.parse(buffer.slice(0, newline)) }))
  socket.end()
})

socket.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})

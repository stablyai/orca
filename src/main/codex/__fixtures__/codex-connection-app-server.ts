export const FAKE_APP_SERVER = String.raw`
  const readline = require('node:readline')
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'initialize') return send({ id: message.id, result: {} })
    if (message.method === 'test/env') {
      return send({ id: message.id, result: { codexHome: process.env.CODEX_HOME ?? null } })
    }
    if (message.method === 'test/cwd') {
      return send({ id: message.id, result: { cwd: process.cwd() } })
    }
    if (message.method === 'test/notify') {
      send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-7' } } })
      return send({ id: message.id, result: {} })
    }
    if (message.method === 'test/ask') {
      return send({ id: 99, method: 'item/fileChange/requestApproval', params: { itemId: 'i1' } })
    }
    if (message.method === 'test/refuse') {
      return send({ id: message.id, error: { code: -32602, message: 'bad params' } })
    }
    if (message.method === 'test/missing') {
      return send({ id: message.id, error: { code: -32601, message: 'method not found' } })
    }
    if (message.id === 99) {
      return send({ method: 'test/answered', params: message })
    }
  })
`

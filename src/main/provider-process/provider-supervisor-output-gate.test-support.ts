import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'

/** Hold real write callbacks after source EOF, without replacing production finalization. */
export async function createSupervisorOutputGate(directory: string) {
  const path = join(directory, 'output-gate.sock')
  const sockets = new Set<Socket>()
  const observed = new Set<string>()
  const pending = Promise.withResolvers<void>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    let text = ''
    socket.on('data', (chunk) => {
      text += chunk.toString()
      let newline: number
      while ((newline = text.indexOf('\n')) !== -1) {
        observed.add(text.slice(0, newline))
        text = text.slice(newline + 1)
      }
      if (
        ['pending:stdout', 'pending:stderr', 'end:stdout', 'end:stderr'].every((event) =>
          observed.has(event)
        )
      ) {
        pending.resolve()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  return {
    pending: pending.promise,
    release: () => {
      for (const socket of sockets) {
        socket.write('release\n')
      }
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    instrument: (source: string): string => {
      const marker = '// A spawn that failed outright'
      if (!source.includes(marker)) {
        throw new Error('Supervisor output gate location missing')
      }
      return source.replace(
        marker,
        `
const completionGate = await new Promise((resolve, reject) => {
  const socket = require('node:net').connect(${JSON.stringify(path)}, () => resolve(socket))
  socket.on('error', reject)
})
let writesReleased = false
const pendingWrites = []
completionGate.on('data', () => {
  writesReleased = true
  for (const complete of pendingWrites.splice(0)) complete()
})
for (const [name, source, destination] of [['stdout', child.stdout, output], ['stderr', child.stderr, errorOutput]]) {
  const write = destination._write
  destination._write = function(chunk, encoding, complete) {
    write.call(this, chunk, encoding, error => {
      if (writesReleased) return complete(error)
      pendingWrites.push(() => complete(error))
      completionGate.write('pending:' + name + '\\n')
    })
  }
  source.once('end', () => completionGate.write('end:' + name + '\\n'))
}
${marker}`
      )
    }
  }
}

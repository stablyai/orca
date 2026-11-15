import { createServer } from 'node:http'
import { createRelay } from './relay.ts'

const server = createServer(createRelay())
// Long Codex turns stream for minutes: no Node-side request or header timeout (Cloud Run caps it).
server.requestTimeout = 0
server.headersTimeout = 0
server.listen(Number(process.env.PORT ?? 8080), () => console.log(JSON.stringify({ event: 'relay_listening' })))

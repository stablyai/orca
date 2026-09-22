import { spawn } from 'node:child_process'

const [brokerPath, instanceId, runtimeId, authorizedAccount] = process.argv.slice(2)
const broker = spawn(brokerPath, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  shell: false
})
broker.stdin.end(
  [
    'ORCA_RUNTIME_PIPE_BROKER_V2',
    instanceId,
    String(process.pid),
    runtimeId,
    authorizedAccount,
    '10000',
    ''
  ].join('\n')
)
broker.stdout.once('data', (chunk) => {
  process.stdout.write(`BROKER_PID=${broker.pid}\n${chunk.toString()}`)
})
setInterval(() => {}, 1000)

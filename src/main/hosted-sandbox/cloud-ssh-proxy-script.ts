// The ProxyCommand ssh runs for an Orca Cloud workspace (`ssh orca-cloud-<name>`): wake first via
// the control plane's ssh-wake route (scoped per-sandbox secret, not the user's token), then pipe
// ssh's stdio over the VM's wss bridge. Plain Node (run by Electron as node), no dependencies.
export const CLOUD_SSH_PROXY_SCRIPT = String.raw`'use strict'
// Usage: node orca-cloud-ssh-proxy.cjs <wake-url> <secret-file>
const fs = require('fs')
const [wakeUrl, secretFile] = process.argv.slice(2)
const fail = (msg) => { process.stderr.write('orca-cloud: ' + msg + '\n'); process.exit(255) }
if (!wakeUrl || !secretFile) fail('usage: orca-cloud-ssh-proxy <wake-url> <secret-file>')
if (typeof WebSocket !== 'function') fail('this runtime has no WebSocket client')
;(async () => {
  const secret = fs.readFileSync(secretFile, 'utf8').trim()
  let answer = null
  const started = Date.now()
  for (let i = 0; i < 6; i++) {
    const res = await fetch(wakeUrl, { method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' }, body: '{"wait":true}' }).catch((e) => fail('control plane unreachable: ' + e.message))
    answer = await res.json().catch(() => ({}))
    if (res.status !== 200 && res.status !== 202) fail('wake refused (' + (answer.error || res.status) + (answer.reason ? ': ' + answer.reason : '') + ')')
    if (answer.state === 'ready' && answer.endpoint) break
    if (answer.state !== 'waking') fail('workspace is ' + answer.state)
    process.stderr.write('orca-cloud: waking workspace… ' + Math.round((Date.now() - started) / 1000) + 's\n')
  }
  if (!answer || answer.state !== 'ready' || !answer.endpoint) fail('workspace did not wake in time')
  const ws = new WebSocket(answer.endpoint)
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => {
    process.stdin.on('data', (chunk) => ws.send(chunk))
    process.stdin.on('end', () => ws.close())
  }
  ws.onmessage = (event) => process.stdout.write(Buffer.from(event.data))
  ws.onerror = () => fail('connection to the workspace failed')
  ws.onclose = () => process.exit(0)
})()
`

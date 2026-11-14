const { join } = require('node:path')

const resourcesDirectory = process.argv[2]
if (!resourcesDirectory) {
  throw new Error('linux-packaged-node-pty-floor-resources-required')
}

const pty = require(join(resourcesDirectory, 'node_modules', 'node-pty'))
const expected = 'orca-node-pty-floor-ok'
let output = ''
let settled = false
const child = pty.spawn('/bin/sh', ['-c', `printf ${expected}; sleep 0.1`], {
  name: 'xterm-color',
  cols: 80,
  rows: 24,
  cwd: '/tmp',
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }
})

const timeout = setTimeout(() => {
  if (settled) {
    return
  }
  settled = true
  child.kill()
  process.stderr.write('packaged node-pty floor smoke timed out\n')
  process.exitCode = 1
}, 5_000)

child.onData((data) => {
  output = `${output}${data}`.slice(-256)
})
child.onExit(({ exitCode }) => {
  if (settled) {
    return
  }
  settled = true
  clearTimeout(timeout)
  if (exitCode !== 0 || output !== expected) {
    process.stderr.write(
      `packaged node-pty floor smoke failed: exit=${exitCode} bytes=${Buffer.byteLength(output)}\n`
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(`${expected}\n`)
})

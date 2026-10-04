// Runs under the pinned Node: load the staged node-pty, open a PTY, echo, and exit.
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const [nodePtyDir, expectedVersion] = process.argv.slice(2)
if (!nodePtyDir || !expectedVersion) {
  throw new Error('usage: orcad-prebuild-smoke-child.cjs <node-pty dir> <expected node version>')
}
if (process.version !== `v${expectedVersion}`) {
  throw new Error(`smoke must run on the pinned Node v${expectedVersion}, got ${process.version}`)
}

const pty = require(nodePtyDir)
if (process.platform === 'win32') {
  // Loaded only by the non-DLL kill path; prove the shipped module still loads under this Node.
  const { loadNativeModule } = require(join(nodePtyDir, 'lib', 'utils'))
  loadNativeModule('conpty_console_list')
}

const token = 'orca-prebuild-smoke-ok'
let output = ''
let settled = false
// Why the pinned node as the child: no shell, so no platform quoting and no cmd.exe /c.
const child = pty.spawn(
  process.execPath,
  ['-e', `process.stdout.write(${JSON.stringify(token)})`],
  {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: tmpdir(),
    env: process.env,
    ...(process.platform === 'win32' ? { useConptyDll: true } : {})
  }
)

const timeout = setTimeout(() => {
  settled = true
  child.kill()
  process.stderr.write(`prebuild smoke timed out; output so far: ${JSON.stringify(output)}\n`)
  process.exit(1)
}, 20_000)

child.onData((data) => {
  output = `${output}${data}`.slice(-4096)
})
child.onExit(({ exitCode }) => {
  if (settled) {
    return
  }
  settled = true
  clearTimeout(timeout)
  if (exitCode !== 0 || !output.includes(token)) {
    process.stderr.write(
      `prebuild smoke failed: exit=${exitCode} output=${JSON.stringify(output)}\n`
    )
    process.exit(1)
  }
  process.stdout.write(`${token} node=${process.version} napi=${process.versions.napi}\n`)
  process.exit(0)
})

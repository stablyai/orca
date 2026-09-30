const fs = require('node:fs')
const { spawn } = require('node:child_process')
const pty = require('node-pty')

const bundle = process.argv[2]
const resultPath = process.argv[3]

async function main() {
  const { TerminalHost, createDaemonPtySubprocessHandle } = require(bundle)
  let output = ''
  const canary = spawn('/bin/sh', ['-c', 'while :; do sleep 1; done'], {
    stdio: 'ignore'
  })
  canary.unref()
  const childScript =
    'setsid /bin/sh -c \'trap "" TERM; while :; do sleep 1; done\' & echo ORCA_DESCENDANT:$!; while :; do sleep 1; done'
  const native = pty.spawn('/bin/sh', ['-c', childScript], {
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: { ...process.env, TERM: 'xterm-256color' }
  })
  const handle = createDaemonPtySubprocessHandle({
    process: native,
    shellPath: '/bin/sh',
    spawnCwd: '/tmp',
    env: { ...process.env, TERM: 'xterm-256color' },
    startupCommandDeliveredInShellArgs: true,
    reportsChildExitStatus: true,
    sessionId: 'docker-daemon-shutdown-descendant',
    startupAgentRecognition: null
  })
  const host = new TerminalHost({ spawnSubprocess: () => handle })
  try {
    await host.createOrAttach({
      sessionId: 'docker-daemon-shutdown-descendant',
      cols: 80,
      rows: 24,
      streamClient: { onData: (data) => (output += data), onExit: () => {} }
    })
    const deadline = Date.now() + 5_000
    let childPid = null
    while (Date.now() < deadline) {
      const match = output.match(/ORCA_DESCENDANT:(\d+)/)
      if (match) {
        childPid = Number(match[1])
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (!childPid) {
      throw new Error(`descendant pid was not reported: ${JSON.stringify(output)}`)
    }
    const childStat = fs.readFileSync(`/proc/${childPid}/stat`, 'utf8').split(' ')
    if (Number(childStat[3]) !== native.pid || Number(childStat[5]) !== childPid) {
      throw new Error('fixture child is not a live descendant in its own POSIX session')
    }
    const shutdownStarted = Date.now()
    await host.dispose()
    const shutdownMs = Date.now() - shutdownStarted
    fs.writeFileSync(resultPath, JSON.stringify({ childPid, canaryPid: canary.pid, shutdownMs }))
    process.exit(0)
  } catch (error) {
    canary.kill('SIGKILL')
    native.kill('SIGKILL')
    throw error
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

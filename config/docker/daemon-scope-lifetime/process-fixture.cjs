const fs = require('node:fs')
const { spawn } = require('node:child_process')

const [role, resultPath, bundlePath, nonce, ownership = 'exclusive'] = process.argv.slice(2)

if (role === 'worker') {
  global.retained = Buffer.alloc(24 * 1024 * 1024, 1)
  process.on('SIGTERM', () => {})
  fs.writeFileSync(resultPath, String(process.pid))
  setInterval(() => global.retained[0]++, 1000)
} else if (role === 'intermediate') {
  const child = spawn(process.execPath, [__filename, 'worker', resultPath], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
} else if (role === 'runtime') {
  const { buildDurableDaemonScopeCommand } = require(bundlePath)
  const command = buildDurableDaemonScopeCommand(
    process.execPath,
    [__filename, 'daemon', resultPath, bundlePath, nonce, ownership],
    nonce,
    process.env
  )
  const daemon = spawn(command.command, command.args, {
    detached: true,
    stdio: 'ignore',
    env: command.env
  })
  daemon.unref()
} else if (role === 'daemon') {
  const { startScopeReaper } = require(bundlePath)
  const watcher = startScopeReaper?.(nonce, ownership !== 'shared')
  if (ownership === 'broken-pipe') {
    watcher?.stdin?.destroy()
  }
  fs.writeFileSync(`${resultPath}.daemon`, String(process.pid))
  spawn(process.execPath, [__filename, 'intermediate', resultPath], { stdio: 'ignore' })
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {
    if (fs.existsSync(`${resultPath}.exit`)) {
      process.exit(0)
    }
  }, 50)
} else {
  throw new Error(`Unknown fixture role: ${role}`)
}

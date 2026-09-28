import { installCliLauncherOwner } from './cli-launcher-owner'

process.on('SIGTERM', () => {
  console.log('owner-loss-shutdown')
  process.exit(0)
})
installCliLauncherOwner()
if (process.argv[2] === '--owner-wait') {
  console.log(
    JSON.stringify({ pid: process.pid, ownerPipe: process.env.ORCA_CLI_LAUNCHER_PIPE ?? null })
  )
  setInterval(() => {}, 1000)
} else {
  console.log(
    JSON.stringify({
      args: process.argv.slice(2),
      bun: process.versions.bun,
      app: process.env.ORCA_APP_EXECUTABLE,
      nodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null,
      packaged: process.env.ORCA_PACKAGED_CLI
    })
  )
  process.exitCode = 17
}

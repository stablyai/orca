#!/usr/bin/env node

// Orca Relay — remote-host daemon and reconnect bridge entry point.

import { parseRelayLaunchOptions, readRelayEndpointCredential } from './relay-launch-options'
import { relayLogLine } from './relay-diagnostic-log'
import {
  isRelayResetPreparationReadMode,
  readRelayResetPreparationStdin
} from './relay-reset-preparation-reader'

async function main(): Promise<void> {
  if (isRelayResetPreparationReadMode(process.argv)) {
    process.stdout.write(await readRelayResetPreparationStdin(process.stdin))
    return
  }
  const options = parseRelayLaunchOptions(process.argv)
  if (options.connectMode) {
    const { runRelayConnectChannel } = await import('./relay-connect-channel')
    runRelayConnectChannel(options.sockPath, readRelayEndpointCredential(options.credentialFile))
    return
  }
  if (options.cliMode) {
    const { runRelayOrcaCliChannel } = await import('./relay-orca-cli-channel')
    const marker = process.argv.indexOf('--orca-cli')
    await runRelayOrcaCliChannel(
      options.sockPath,
      marker === -1 ? [] : process.argv.slice(marker + 1),
      readRelayEndpointCredential(options.credentialFile)
    )
    return
  }
  // Why no read here: the daemon publishes its credential itself, after it owns the socket.
  const { runRelayDaemon } = await import('./relay-daemon')
  await runRelayDaemon(options)
}

void main().catch((error) => {
  relayLogLine(
    `[relay] Fatal startup error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
  )
  process.exit(1)
})

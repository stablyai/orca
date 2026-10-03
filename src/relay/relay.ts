#!/usr/bin/env node

// Orca Relay — remote-host daemon and reconnect bridge entry point.

import { parseRelayLaunchOptions, readRelayEndpointCredential } from './relay-launch-options'
import { runRelayConnectChannel } from './relay-connect-channel'
import { runRelayOrcaCliChannel } from './relay-orca-cli-channel'
import { runRelayDaemon } from './relay-daemon'
import { relayLogLine } from './relay-diagnostic-log'
import { configureRelayBundledRipgrep } from './relay-bundled-ripgrep'
import { runRelayRuntimeSelfTestCommand } from './relay-runtime-self-test'
import { runRelayWindowsBreakawayLaunchIfRequested } from './relay-windows-breakaway-launch'
import { RELAY_RUNTIME_SELF_TEST_FLAG } from '../shared/relay-runtime-self-test-report'

async function main(): Promise<void> {
  const selfTestFlag = process.argv.indexOf(RELAY_RUNTIME_SELF_TEST_FLAG)
  if (selfTestFlag !== -1) {
    await runRelayRuntimeSelfTestCommand(process.argv[selfTestFlag + 1] ?? '')
    return
  }
  if (runRelayWindowsBreakawayLaunchIfRequested(process.argv)) {
    return
  }
  const options = parseRelayLaunchOptions(process.argv)
  if (options.connectMode) {
    runRelayConnectChannel(options.sockPath, readRelayEndpointCredential(options.credentialFile))
    return
  }
  if (options.cliMode) {
    const marker = process.argv.indexOf('--orca-cli')
    await runRelayOrcaCliChannel(
      options.sockPath,
      marker === -1 ? [] : process.argv.slice(marker + 1),
      readRelayEndpointCredential(options.credentialFile)
    )
    return
  }
  configureRelayBundledRipgrep(options.ripgrepPath)
  // Why no read here: the daemon publishes its credential itself, after it owns the socket.
  await runRelayDaemon(options)
}

void main().catch((error) => {
  relayLogLine(
    `[relay] Fatal startup error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
  )
  process.exit(1)
})

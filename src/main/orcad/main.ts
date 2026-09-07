/** Executable entry for `orcad`. See `./orcad-entry.ts`. */
import process from 'node:process'
import { main, resolveOrcadExitCode } from './orcad-entry'
import { runOrcadNativePreflight } from './orcad-native-preflight'
import { isServiceCommand, runServiceCommand } from './orcad-service-command'

// Why exit before the preflight: reaching this line means the whole module graph resolved
// under plain Node, which is all the build guard needs to prove. Probing natives or
// starting a server to prove it would bind a port and take a data-root lock on a build
// machine.
if (process.argv.includes('--orcad-smoke-load-check')) {
  process.exit(0)
}

// Why an exclusive branch and not an early return: the doctor's live probes make the
// service path async, and awaiting in place would let it fall through into the native
// preflight — which is exactly what an operator generating a service definition cannot
// pass yet. `parseArgs` would also reject these flags outright.
if (isServiceCommand(process.argv.slice(2))) {
  runServiceCommand(process.argv.slice(2)).then((code) => process.exit(code))
} else {
  // Why here and not inside startOrcad: this must run before anything requires node-pty,
  // and `orcad-entry` reaches it through `await import('../ipc/pty')`. Static imports are
  // evaluated before this statement, so the guarantee is that no module in the graph
  // requires node-pty at import time — which the bundle's lazy `require("node-pty")` in
  // local-pty-provider satisfies. See ./node-pty-precondition.ts for why a child process.
  runOrcadNativePreflight()

  main().catch((error: unknown) => {
    console.error('orcad: failed to start:', error)
    // Why a resolved code and not a bare 1: a data-root or bind-address refusal is a
    // configuration fault that restarting cannot fix, and a supervisor needs to tell the two
    // apart to avoid restart-spinning on it.
    process.exit(resolveOrcadExitCode(error))
  })
}

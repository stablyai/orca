/** Executable entry for `orcad`. See `./orcad-entry.ts`. */
import process from 'node:process'
import { main } from './orcad-entry'
import { runOrcadNativePreflight } from './orcad-native-preflight'

// Why here and not inside startOrcad: this must run before anything requires node-pty,
// and `orcad-entry` reaches it through `await import('../ipc/pty')`. Static imports are
// evaluated before this statement, so the guarantee is that no module in the graph
// requires node-pty at import time — which the bundle's lazy `require("node-pty")` in
// local-pty-provider satisfies. See ./node-pty-precondition.ts for why a child process.
runOrcadNativePreflight()

main().catch((error: unknown) => {
  console.error('orcad: failed to start:', error)
  process.exit(1)
})

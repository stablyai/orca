/** Executable entry for `orcad`. See `./orcad-entry.ts`. */
import process from 'node:process'
import { main } from './orcad-entry'

main().catch((error: unknown) => {
  console.error('orcad: failed to start:', error)
  process.exit(1)
})

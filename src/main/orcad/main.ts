/** Validate the runtime before loading the application or opening a profile. */
import { realpathSync } from 'node:fs'
import { assertBundledOrcadRuntime, OrcadBundledRuntimeError } from './orcad-bundled-runtime'

function failStartup(error: unknown): void {
  console.error('orcad: failed to start:', error)
  process.exit(error instanceof OrcadBundledRuntimeError ? 78 : 1)
}

try {
  assertBundledOrcadRuntime()
  const entry = process.argv[1]
  if (!entry) {
    throw new OrcadBundledRuntimeError('The Orca entry is missing')
  }
  process.argv[1] = realpathSync(entry)
  void import('./orcad-app').catch((cause: unknown) => {
    failStartup(
      new OrcadBundledRuntimeError('The bundled Orca application could not load', { cause })
    )
  })
} catch (error) {
  failStartup(error)
}

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every host that runs the terminal runtime must hand it the hook server's drain, or committed
// hooks stop landing ahead of the output the agent printed after them.
describe('committed agent hooks runtime wiring', () => {
  it.each(['src/main/startup/main-process-runtime-service.ts', 'src/main/orcad/orcad-entry.ts'])(
    '%s wires the runtime to drain committed hooks',
    (path) => {
      const source = readFileSync(join(process.cwd(), path), 'utf8')
      const construction = source.indexOf('new OrcaRuntimeService(')

      expect(construction).toBeGreaterThanOrEqual(0)
      expect(source.slice(construction)).toContain(
        'drainCommittedAgentHooks: () => agentHookServer.drainCommittedHooks()'
      )
    }
  )
})

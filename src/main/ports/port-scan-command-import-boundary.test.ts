import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why (#11161): libuv runs process creation inline on the calling event loop,
// so the port scan only stays off CrBrowserMain while these main-thread modules
// spawn nothing themselves. Spawning belongs to port-scan-command-execution.ts,
// which only the worker entry imports.
const MAIN_THREAD_MODULES = [
  'local-workspace-port-scanner.ts',
  'port-scan-command-client.ts',
  // The services panel probes the same hot path on every scan tick, so they
  // carry the same no-spawn rule. Stopping a service deliberately does not:
  // service-stop-command-runner.ts owns that spawn and its per-command budget.
  'docker-compose-services.ts',
  'service-process-ancestry.ts'
]

describe('port scan main-thread spawn boundary', () => {
  it.each(MAIN_THREAD_MODULES)('keeps %s free of child_process', (fileName) => {
    const source = readFileSync(join(import.meta.dirname, fileName), 'utf8')

    expect(source).not.toMatch(/from\s+['"](node:)?child_process['"]/)
    expect(source).not.toMatch(/require\(\s*['"](node:)?child_process['"]\s*\)/)
  })
})

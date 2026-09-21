import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the one line that arms pre-gone crash sampling.
 *
 * That branch is pure instrumentation, so this line is the whole of its value in
 * the shipped app: deleting it left all 691 tests across `src/main/crash-reporting/`
 * and `src/main/startup/` green while every crash report silently lost its only
 * host reading taken before the dying process returned its pages.
 *
 * Source-level because that is the property: the sampler is armed once inside the
 * ready-phase composition, which has no runtime seam to assert against.
 */
describe('pre-gone crash sampling startup wiring', () => {
  // Why normalize: the indent anchors below are `\n`-prefixed, and nothing pins
  // src/**/*.ts to LF, so a CRLF Windows checkout would fail them spuriously.
  const readSource = (name: string): string =>
    readFileSync(join(process.cwd(), 'src/main/startup', name), 'utf8').replace(/\r\n/g, '\n')

  const readyRuntimeSource = readSource('main-process-ready-runtime.ts')
  const readySource = readSource('main-process-ready.ts')

  const READY_ENTRY = 'export async function initializeReadyRuntimeServices('
  // Why the entry's body and not the file: the call satisfies a whole-file grep
  // just as well from a sibling export nothing calls, which arms nothing.
  const readyRuntimeEntryBody = readyRuntimeSource
    .slice(readyRuntimeSource.indexOf(READY_ENTRY) + READY_ENTRY.length)
    .split('\nexport ')[0]

  it('arms the sampler unconditionally inside the function app readiness runs', () => {
    expect(readyRuntimeSource).toContain(
      "import { startPreGoneCrashSampling } from '../crash-reporting/process-gone-diagnostics'"
    )
    expect(readyRuntimeSource).toContain(READY_ENTRY)
    expect(readyRuntimeEntryBody.split('startPreGoneCrashSampling()').length - 1).toBe(1)
    // Why pin the indent: the call also matches as the body of an added
    // `if (...)` guard, which keeps every other assertion here true while the
    // sampler silently stops arming on most startups.
    expect(readyRuntimeEntryBody).toContain('\n  startPreGoneCrashSampling()')

    // ...and that this really is the function app readiness runs.
    expect(readySource).toContain(
      "import { initializeReadyRuntimeServices } from './main-process-ready-runtime'"
    )
    expect(readySource).toContain('\n  await initializeReadyRuntimeServices()')
  })
})

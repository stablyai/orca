import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runElectronFixture } from '../../../electron-fixtures/electron-fixture-run'

// Reads Chromium's internal page-state format; an Electron upgrade that changes it must fail here
// (a plain page reading 'unknown' would quietly stop every discard).
it("reads a form POST result from Chromium's history entry in real Electron", async () => {
  const result = await runElectronFixture(
    join(import.meta.dirname, 'browser-page-state-form-data-electron-fixture.ts')
  )
  expect(result.timedOut).toBe(false)
  expect(result.code, `${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0)
  expect(result.output, result.stderr).toEqual({
    plain: 'none',
    post: 'form-data',
    // A 303 turns the POST into a GET page; a 307 re-POSTs.
    seeOther: 'none',
    temporary: 'form-data',
    // History API updates drop the body; it is still readable as the first one starts.
    replaced: { before: 'form-data', after: 'none' },
    savedSelect: { savesType: true, formData: 'none' }
  })
}, 60_000)

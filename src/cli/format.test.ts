import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { printResult } from './format'
import { formatRepoRefs } from './workspace-format'

let testScreenshotDir: string | null = null

it('prints readable branches while distinguishing colliding action identities', () => {
  expect(
    formatRepoRefs({
      refs: ['refs/heads/topic', 'refs/heads/origin/main', 'refs/remotes/origin/main'],
      truncated: false
    })
  ).toBe('topic\nrefs/heads/origin/main\nrefs/remotes/origin/main')
  expect(
    formatRepoRefs({ refs: ['origin/main', 'refs/remotes/origin/main'], truncated: false })
  ).toBe('origin/main\norigin/main')
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR
  if (testScreenshotDir) {
    rmSync(testScreenshotDir, { recursive: true, force: true })
    testScreenshotDir = null
  }
})

describe('printResult computer screenshots', () => {
  it('keeps inline screenshot data when temp export fails', () => {
    testScreenshotDir = join(tmpdir(), `orca-format-blocked-${Date.now()}`)
    writeFileSync(testScreenshotDir, 'not-a-directory')
    process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR = testScreenshotDir
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const screenshotData = Buffer.from('png-data').toString('base64')

    printResult(
      {
        id: 'req-export-fail',
        ok: true,
        result: {
          screenshot: {
            data: screenshotData,
            format: 'png',
            width: 1,
            height: 1,
            scale: 1
          },
          screenshotStatus: { state: 'captured' }
        },
        _meta: { runtimeId: 'runtime-1' }
      },
      true,
      () => 'unused'
    )

    const output = JSON.parse(logSpy.mock.calls[0][0]) as {
      result: { screenshot: { data: string; path?: string; dataOmitted?: boolean } }
    }
    expect(output.result.screenshot.data).toBe(screenshotData)
    expect(output.result.screenshot.path).toBeUndefined()
    expect(output.result.screenshot.dataOmitted).toBeUndefined()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { runProcess } from '@orca/process-host'

type ProcessSpec = Parameters<typeof runProcess>[0]
type ProcessResult = Awaited<ReturnType<typeof runProcess>>
import {
  checkHelperSignatures,
  resetHelperSignatureChecksForTests
} from '../tcc-denial-signature-checks'

const APP_REQUIREMENT =
  'identifier "com.stablyai.orca" and anchor apple generic and certificate leaf[subject.OU] = "6CX3WHS9HZ"'
const HELPER =
  '/Users/user/Library/Application Support/orca/daemon-host/macos/terminal-host-1/app.noindex/Orca Terminal Host.app/Contents/MacOS/orca-terminal-host'

function result(code: number | null, stdout = '', stderr = '', timedOut = false): ProcessResult {
  return { code, signal: null, stdout, stderr, timedOut }
}

type Replies = { liveVerify: ProcessResult; liveRequirement: string; diskVerify: ProcessResult }

function codesignFake(replies: Replies) {
  return vi.fn(async (spec: ProcessSpec): Promise<ProcessResult> => {
    const args = spec.args ?? []
    const target = args.at(-1) ?? ''
    if (args[0] === '--display') {
      return target.startsWith('+')
        ? result(0, `designated => ${replies.liveRequirement}\n`)
        : result(0, `designated => ${APP_REQUIREMENT}\n`)
    }
    return target.startsWith('+') ? replies.liveVerify : replies.diskVerify
  })
}

beforeEach(() => {
  resetHelperSignatureChecksForTests()
  vi.spyOn(process, 'execPath', 'get').mockReturnValue('/Applications/Orca.app/Contents/MacOS/Orca')
})

describe('checkHelperSignatures', () => {
  it('passes a live helper carrying the app requirement and verifies the copy bundle', async () => {
    const run = codesignFake({
      liveVerify: result(0),
      liveRequirement: APP_REQUIREMENT,
      diskVerify: result(1, '', 'a sealed resource is missing or invalid')
    })
    expect(await checkHelperSignatures(1206, HELPER, run)).toEqual({
      live: 'pass',
      diskCopy: 'fail'
    })
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          '--verify',
          '--strict',
          '/Users/user/Library/Application Support/orca/daemon-host/macos/terminal-host-1/app.noindex/Orca Terminal Host.app'
        ]
      })
    )
  })

  it('fails a live helper whose requirement differs from the app', async () => {
    const run = codesignFake({
      liveVerify: result(0),
      liveRequirement: 'identifier "com.stablyai.orca" and anchor apple generic',
      diskVerify: result(0)
    })
    expect((await checkHelperSignatures(1206, HELPER, run)).live).toBe('fail')
  })

  it('reports error, not fail, for a gone pid, a timeout or a missing path', async () => {
    const gone = codesignFake({
      liveVerify: result(1, '', '+1206: host has no guest with the requested attributes'),
      liveRequirement: APP_REQUIREMENT,
      diskVerify: result(null, '', '', true)
    })
    expect(await checkHelperSignatures(1206, HELPER, gone)).toEqual({
      live: 'error',
      diskCopy: 'error'
    })
    const noPath = codesignFake({
      liveVerify: result(0),
      liveRequirement: APP_REQUIREMENT,
      diskVerify: result(0)
    })
    expect((await checkHelperSignatures(1206, null, noPath)).diskCopy).toBe('error')
  })
})

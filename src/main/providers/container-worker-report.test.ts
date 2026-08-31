import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'

describe('container worker lifecycle reporter', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function invocation(root: string, subject: string) {
    return runProcess({
      program: process.execPath,
      args: [
        join(process.cwd(), 'config/worker-authority-image/container-worker-report.mjs'),
        '--type',
        'worker_done',
        '--outcome',
        'succeeded',
        '--subject',
        subject,
        '--body',
        'completed safely'
      ],
      env: {
        ...process.env,
        ORCA_DISPATCH_ID: 'dispatch_report_test',
        ORCA_LIFECYCLE_BINDING: `sha256:${'1'.repeat(64)}`,
        ORCA_LIFECYCLE_DIR: root
      }
    })
  }

  it('publishes a complete create-only receipt', async () => {
    const root = mkdtempSync('/private/tmp/orca-worker-report-test-')
    roots.push(root)

    expect((await invocation(root, 'complete')).code).toBe(0)
    expect(JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'))).toMatchObject({
      schemaVersion: 'worker_lifecycle_receipt/1',
      dispatchId: 'dispatch_report_test',
      type: 'worker_done',
      subject: 'complete',
      outcome: 'succeeded'
    })
    expect(readdirSync(root)).toEqual(['result.json'])
  })

  it('admits only one writer under concurrency without exposing a staging file', async () => {
    const root = mkdtempSync('/private/tmp/orca-worker-report-race-test-')
    roots.push(root)

    const results = await Promise.all([invocation(root, 'first'), invocation(root, 'second')])
    expect(results.map((result) => result.code).sort()).toEqual([0, 1])
    const receipt = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) as {
      subject: string
    }
    expect(['first', 'second']).toContain(receipt.subject)
    expect(readdirSync(root)).toEqual(['result.json'])
  })
})

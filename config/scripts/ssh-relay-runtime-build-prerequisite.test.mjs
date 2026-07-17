import { readFile } from 'node:fs/promises'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflowUrl = new URL(
  '../../.github/workflows/ssh-relay-runtime-artifacts.yml',
  import.meta.url
)
const releaseCutUrl = new URL('../../.github/workflows/release-cut.yml', import.meta.url)
const releaseMacUrl = new URL('../../.github/workflows/release-mac-build.yml', import.meta.url)

describe('SSH relay runtime reusable build prerequisite', () => {
  it('exposes the exact credential-free native graph without a release consumer', async () => {
    const [source, releaseCut, releaseMac] = await Promise.all([
      readFile(workflowUrl, 'utf8'),
      readFile(releaseCutUrl, 'utf8'),
      readFile(releaseMacUrl, 'utf8')
    ])
    const workflow = parse(source)

    expect(workflow.on.workflow_call).toEqual({
      inputs: {
        'include-baseline-gates': {
          description: 'Run separately gated oldest-baseline qualification jobs',
          required: false,
          default: true,
          type: 'boolean'
        }
      }
    })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(workflow.jobs)).toEqual([
      'build-posix-runtime',
      'build-windows-runtime',
      'verify-linux-runtime-baseline-userland',
      'verify-windows-runtime-baseline'
    ])
    expect(workflow.jobs['verify-linux-runtime-baseline-userland'].needs).toBe(
      'build-posix-runtime'
    )
    expect(workflow.jobs['verify-windows-runtime-baseline'].needs).toBe('build-windows-runtime')
    for (const jobName of [
      'verify-linux-runtime-baseline-userland',
      'verify-windows-runtime-baseline'
    ]) {
      expect(workflow.jobs[jobName].if).toBe(
        "github.event_name != 'workflow_call' || inputs.include-baseline-gates"
      )
    }
    for (const job of Object.values(workflow.jobs)) {
      expect(job.steps[0].with.ref).toBe('${{ github.event.pull_request.head.sha || github.sha }}')
    }
    expect(source).not.toMatch(/\$\{\{\s*secrets\./u)
    // Why: this slice proves a callable build graph without changing the production release DAG.
    for (const consumer of [releaseCut, releaseMac]) {
      expect(consumer).not.toContain('ssh-relay-runtime-artifacts.yml')
      expect(consumer).not.toContain('ssh-relay-runtime-')
    }
  })
})

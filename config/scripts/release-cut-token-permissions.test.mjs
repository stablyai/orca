import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const RELEASE_WORKFLOW = '.github/workflows/release-cut.yml'
const EXPECTED_MATRIX = {
  '.github/workflows/docs.yml#check': { contents: 'read' },
  '.github/workflows/docs.yml#production': { contents: 'read' },
  '.github/workflows/docs.yml#release_gate': { contents: 'read' },
  '.github/workflows/e2e.yml#build': { contents: 'read' },
  '.github/workflows/e2e.yml#changed-e2e': { contents: 'read' },
  '.github/workflows/e2e.yml#e2e': { contents: 'read' },
  '.github/workflows/e2e.yml#prepare-native-cache': { contents: 'read' },
  '.github/workflows/e2e.yml#ssh-docker-watcher-isolation': { contents: 'read' },
  '.github/workflows/homebrew-bump.yml#bump-cask': { contents: 'read' },
  '.github/workflows/release-mac-build.yml#build-mac': { contents: 'write' },
  [`${RELEASE_WORKFLOW}#build`]: { actions: 'read', contents: 'write' },
  [`${RELEASE_WORKFLOW}#build-mac`]: { actions: 'write', contents: 'read' },
  [`${RELEASE_WORKFLOW}#create-release`]: { contents: 'write' },
  [`${RELEASE_WORKFLOW}#cut`]: { contents: 'write' },
  [`${RELEASE_WORKFLOW}#docs-production-dispatch`]: { actions: 'write' },
  [`${RELEASE_WORKFLOW}#homebrew-bump`]: { contents: 'read' },
  [`${RELEASE_WORKFLOW}#homebrew-bump -> .github/workflows/homebrew-bump.yml#bump-cask`]: {
    contents: 'read'
  },
  [`${RELEASE_WORKFLOW}#homebrew-bump-published-rc-draft`]: { contents: 'read' },
  [`${RELEASE_WORKFLOW}#homebrew-bump-published-rc-draft -> .github/workflows/homebrew-bump.yml#bump-cask`]:
    {
      contents: 'read'
    },
  [`${RELEASE_WORKFLOW}#post-release-e2e`]: { actions: 'write' },
  [`${RELEASE_WORKFLOW}#publish-release`]: { contents: 'write' },
  [`${RELEASE_WORKFLOW}#release-preflight`]: { contents: 'read' },
  [`${RELEASE_WORKFLOW}#skill-sharing-linux-floor-release-gate`]: { contents: 'read' },
  [`${RELEASE_WORKFLOW}#skill-sharing-release-gate`]: { contents: 'read' },
  [`${RELEASE_WORKFLOW}#terminal-rendering-golden`]: { contents: 'read' },
  [`${RELEASE_WORKFLOW}#terminal-rendering-release-evidence`]: { contents: 'read' }
}
const PUBLISH_TAG_JOBS = new Set(['build', 'create-release'])
const RELEASE_TAG_EXECUTION_JOBS = [
  'build',
  'create-release',
  'skill-sharing-linux-floor-release-gate',
  'skill-sharing-release-gate',
  'terminal-rendering-golden',
  'terminal-rendering-release-evidence'
]
const REUSABLE_CALL_JOBS = ['homebrew-bump', 'homebrew-bump-published-rc-draft']

function readWorkflow(relativePath) {
  const ref = process.env.RELEASE_CUT_WORKFLOW_REF
  const source = ref
    ? execFileSync('git', ['show', `${ref}:${relativePath}`], { encoding: 'utf8' })
    : readFileSync(relativePath, 'utf8')
  return parse(source)
}

function normalizePermissions(permissions) {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw new Error(`Expected an explicit permission map, received ${String(permissions)}`)
  }
  return Object.fromEntries(
    Object.entries(permissions).sort(([left], [right]) => left.localeCompare(right))
  )
}

function intersectPermissions(granted, requested) {
  const rank = { none: 0, read: 1, write: 2 }
  const scopes = new Set([...Object.keys(granted), ...Object.keys(requested)])
  return Object.fromEntries(
    [...scopes]
      .map((scope) => {
        const grantedLevel = granted[scope] ?? 'none'
        const requestedLevel = requested[scope] ?? 'none'
        return [scope, rank[grantedLevel] < rank[requestedLevel] ? grantedLevel : requestedLevel]
      })
      .filter(([, level]) => level !== 'none')
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

function resolveWorkflowMatrix(workflow, workflowPath, inheritedPermissions, prefix = '') {
  const workflowPermissions = workflow.permissions
    ? normalizePermissions(workflow.permissions)
    : inheritedPermissions

  return Object.entries(workflow.jobs).reduce((matrix, [jobName, job]) => {
    const requested = job.permissions ? normalizePermissions(job.permissions) : workflowPermissions
    if (!requested) {
      throw new Error(`${workflowPath}#${jobName} has no resolvable permissions`)
    }
    const effective = inheritedPermissions
      ? intersectPermissions(inheritedPermissions, requested)
      : requested
    const identity = prefix
      ? `${prefix} -> ${workflowPath}#${jobName}`
      : `${workflowPath}#${jobName}`
    matrix[identity] = effective

    if (job.uses?.startsWith('./.github/workflows/')) {
      const calledPath = job.uses.slice(2)
      Object.assign(
        matrix,
        resolveWorkflowMatrix(readWorkflow(calledPath), calledPath, effective, identity)
      )
    }
    return matrix
  }, {})
}

function applyFault(workflow) {
  if (process.env.RELEASE_CUT_PERMISSION_FAULT !== 'inherit-write') {
    return workflow
  }
  workflow.permissions = { contents: 'write' }
  delete workflow.jobs.cut.permissions
  return workflow
}

function checkoutRef(job) {
  return job.steps?.find((step) => step.uses === 'actions/checkout@v6')?.with?.ref
}

function discoverDispatchedWorkflowPaths(workflow) {
  const names = new Set()
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      for (const [key, value] of Object.entries(step.env ?? {})) {
        if (key.endsWith('_WORKFLOW') && typeof value === 'string' && /\.ya?ml$/.test(value)) {
          names.add(value)
        }
      }
      for (const match of step.run?.matchAll(/\bgh workflow run ([\w.-]+\.ya?ml)\b/g) ?? []) {
        names.add(match[1])
      }
    }
  }
  return [...names].sort().map((name) => `.github/workflows/${name}`)
}

function discoverStandaloneReusablePaths(workflow) {
  return [
    ...new Set(
      Object.values(workflow.jobs)
        .map((job) => job.uses)
        .filter((uses) => uses?.startsWith('./.github/workflows/'))
        .map((uses) => uses.slice(2))
        .filter((path) => readWorkflow(path).on?.workflow_dispatch)
    )
  ].sort()
}

function releaseTagExecutionJobs(workflow) {
  return Object.entries(workflow.jobs).filter(([, job]) => {
    const checkoutIndex = job.steps?.findIndex((step) => step.uses === 'actions/checkout@v6') ?? -1
    return (
      checkoutRef(job) === 'refs/tags/${{ needs.cut.outputs.tag }}' &&
      job.steps.slice(checkoutIndex + 1).some((step) => step.run || step.uses?.startsWith('./'))
    )
  })
}

describe('release-cut token permissions', () => {
  const workflow = applyFault(readWorkflow(RELEASE_WORKFLOW))
  const reachedWorkflowPaths = [
    ...discoverDispatchedWorkflowPaths(workflow),
    ...discoverStandaloneReusablePaths(workflow)
  ]
  const matrix = reachedWorkflowPaths.reduce(
    (result, workflowPath) =>
      Object.assign(result, resolveWorkflowMatrix(readWorkflow(workflowPath), workflowPath)),
    resolveWorkflowMatrix(workflow, RELEASE_WORKFLOW)
  )

  it('keeps the complete effective job and reusable-workflow matrix least-privileged', () => {
    expect(matrix).toEqual(EXPECTED_MATRIX)
  })

  it('runs release-tagged non-publishing code with read-only contents access', () => {
    const tagJobs = releaseTagExecutionJobs(workflow)
    expect(tagJobs.map(([jobName]) => jobName).sort()).toEqual(RELEASE_TAG_EXECUTION_JOBS)
    for (const [jobName] of tagJobs) {
      if (!PUBLISH_TAG_JOBS.has(jobName)) {
        expect(matrix[`${RELEASE_WORKFLOW}#${jobName}`]).toEqual({ contents: 'read' })
      }
    }
  })

  it('keeps fork, tag, and reusable-workflow boundaries explicit', () => {
    expect(workflow.jobs.cut.if).toBe("github.repository == 'stablyai/orca'")
    expect(checkoutRef(workflow.jobs.cut)).toBe(
      "${{ github.event_name == 'schedule' && 'main' || inputs.ref }}"
    )

    for (const [jobName] of releaseTagExecutionJobs(workflow)) {
      if (!PUBLISH_TAG_JOBS.has(jobName)) {
        expect(workflow.jobs[jobName].needs).toBe('cut')
        expect(workflow.jobs[jobName].if).toBe("needs.cut.outputs.should_release == 'true'")
      }
    }
    for (const jobName of REUSABLE_CALL_JOBS) {
      expect(workflow.jobs[jobName].uses).toBe('./.github/workflows/homebrew-bump.yml')
      expect(matrix[`${RELEASE_WORKFLOW}#${jobName}`]).toEqual({ contents: 'read' })
    }

    const macWorkflow = readWorkflow('.github/workflows/release-mac-build.yml')
    expect(macWorkflow.jobs['build-mac'].if).toBe("github.repository == 'stablyai/orca'")
    expect(checkoutRef(macWorkflow.jobs['build-mac'])).toBe('refs/tags/${{ inputs.tag }}')

    const e2eWorkflow = readWorkflow('.github/workflows/e2e.yml')
    for (const jobName of Object.keys(e2eWorkflow.jobs)) {
      expect(matrix[`.github/workflows/e2e.yml#${jobName}`]).toEqual({ contents: 'read' })
    }
  })
})

import { rm } from 'node:fs/promises'
import {
  createWorkspaceSpaceFixture,
  measureWorkspaceSpaceScan,
  type WorkspaceSpaceScanResult
} from './workspace-space-scan-fixture'
import {
  measureWorkspaceSpaceDecisionShape,
  measureWorkspaceSpaceProjection,
  type WorkspaceSpaceDecisionShapeResult,
  type WorkspaceSpaceProjectionResult
} from './workspace-space-ui-projection-benchmark'

export type WorkspaceSpaceBenchmarkResult = {
  scanResults: WorkspaceSpaceScanResult[]
  projectionResults: WorkspaceSpaceProjectionResult[]
  decisionShapeResults: WorkspaceSpaceDecisionShapeResult[]
}

export async function runWorkspaceSpaceBenchmark(): Promise<WorkspaceSpaceBenchmarkResult> {
  const scanResults: WorkspaceSpaceScanResult[] = []
  for (const repoCount of [10, 30]) {
    const fixture = await createWorkspaceSpaceFixture(repoCount)
    try {
      scanResults.push(await measureWorkspaceSpaceScan(fixture))
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
  return {
    scanResults,
    projectionResults: [1000, 5000].flatMap(measureWorkspaceSpaceProjection),
    decisionShapeResults: [1000, 5000].map(measureWorkspaceSpaceDecisionShape)
  }
}

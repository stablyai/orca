import type {
  ProfileStateDomainReplacement,
  PreparedProfileStateWrite
} from '../../loading-store/profile-writing/profile-state-authority'
import { ProfileStateWriterConnection } from './profile-state-writer-connection'
import './profile-state-writer-worker-path'
import './profile-state-writer-errors'

export class ProfileStateWriteWorkerClient extends ProfileStateWriterConnection {
  writePreparedState(write: PreparedProfileStateWrite): Promise<number> {
    return this.dispatch({ command: 'write-prepared', write }).then((response) => response.revision)
  }

  assertWritable(): void {
    this.assertDispatchable()
  }

  writeSerializedState(payload: Buffer): Promise<number> {
    return this.dispatch({ command: 'write-state', payload }).then((response) => response.revision)
  }

  writeCompleteSerializedDomains(
    replacements: readonly ProfileStateDomainReplacement[]
  ): Promise<number> {
    return this.dispatch({ command: 'write-complete', replacements }).then(
      (response) => response.revision
    )
  }

  writeSerializedDomains(replacements: readonly ProfileStateDomainReplacement[]): Promise<number> {
    return this.dispatch({ command: 'write-domains', replacements }).then(
      (response) => response.revision
    )
  }

  writeSerializedAutomationRuns(
    replacements: readonly ProfileStateDomainReplacement[],
    runs: readonly unknown[]
  ): Promise<number> {
    try {
      this.assertDispatchable()
      const runPayloads = runs.map((run) => {
        const payload = JSON.stringify(run)
        if (payload === undefined) {
          throw new Error('Automation run is not serializable')
        }
        return payload
      })
      return this.dispatch({ command: 'write-automation', replacements, runPayloads }).then(
        (response) => response.revision
      )
    } catch (error) {
      return Promise.reject(error)
    }
  }

  assertCurrentRevision(): Promise<number> {
    return this.dispatch({ command: 'assert-revision' }).then((response) => response.revision)
  }

  writeJsonExport(targetPath: string): Promise<number> {
    return this.dispatch({ command: 'export-json', targetPath }).then(
      (response) => response.exportedRevision ?? response.revision
    )
  }

  writeLatestJsonExport(dataFile: string): Promise<number | undefined> {
    return this.dispatch({ command: 'export-latest', targetPath: dataFile }).then(
      (response) => response.exportedRevision ?? undefined
    )
  }
}

import type {
  JournalPersistenceEffect,
  JournalEffectResult
} from '../../native-chat/agent-session-journal/journal-persistence-plan'
import {
  journalTransferBatches,
  journalUnitPackets,
  receiveJournalResult
} from '../../native-chat/agent-session-journal/journal-unit-transfer'
import type { SurfaceJointTransaction } from '../../workspace-surfaces/surface-joint-transaction'
import type { ProfileStateDomainReplacement } from '../loading-store/profile-state-authority'
import { ProfileStateWriterConnection } from './profile-state-writer-connection'
import type {
  SurfaceStorageCommand,
  SurfaceStorageMutation,
  SurfaceStorageResult
} from '../../../shared/workspace-surfaces/surface-storage-command'
export { resolveProfileStateWriterWorkerPath } from './profile-state-writer-worker-path'
export {
  ProfileStateWriterError,
  profileStateWriterFailureOutcome
} from './profile-state-writer-errors'
export type { ProfileStateWriterInitialization } from './profile-state-writer-protocol'

export class ProfileStateWriteWorkerClient extends ProfileStateWriterConnection {
  executeSurfaceCommand(surface: SurfaceStorageCommand): Promise<SurfaceStorageResult> {
    return this.dispatch({ command: 'write-surface', surface }).then((response) => {
      if (!response.surfaceResult) {
        throw new Error('Profile state writer omitted the committed surface result')
      }
      return response.surfaceResult
    })
  }

  executeSurfaceTransaction(
    surfaces: readonly SurfaceStorageMutation[]
  ): Promise<SurfaceStorageResult[]> {
    return this.dispatch({ command: 'write-surfaces', surfaces }).then((response) => {
      if (!response.surfaceResults || response.surfaceResults.length !== surfaces.length) {
        throw new Error('Profile state writer omitted committed surface results')
      }
      return response.surfaceResults
    })
  }

  executeSurfaceJointTransaction(
    transaction: SurfaceJointTransaction
  ): Promise<SurfaceStorageResult[]> {
    return this.dispatch({ command: 'write-surface-joint', transaction }).then((response) => {
      if (
        !response.surfaceResults ||
        response.surfaceResults.length !== transaction.commands.length
      ) {
        throw new Error('Profile state writer omitted committed joint surface results')
      }
      return response.surfaceResults
    })
  }

  async executeSurfaceJournalUnit(
    transaction: SurfaceJointTransaction,
    effects: readonly JournalPersistenceEffect[]
  ) {
    await this.dispatch({ command: 'stage-surface-journal', packets: null })
    for (const packets of journalTransferBatches(journalUnitPackets(effects))) {
      await this.dispatch({ command: 'stage-surface-journal', packets })
    }
    const values: JournalEffectResult[] = []
    const response = await this.dispatch(
      {
        command: 'write-surface-joint',
        transaction: { ...transaction, effectCount: effects.length }
      },
      (packets) => {
        for (const packet of packets) {
          if (!packet || packet.index >= effects.length) {
            throw new Error('Unexpected native unit result packet')
          }
          receiveJournalResult(values, packet)
        }
      }
    )
    if (
      !response.surfaceResults ||
      response.surfaceResults.length !== transaction.commands.length ||
      values.length !== effects.length
    ) {
      throw new Error('Profile state writer omitted the committed native unit')
    }
    return { surfaces: response.surfaceResults, values }
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

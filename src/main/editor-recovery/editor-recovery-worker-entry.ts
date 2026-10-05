import { parentPort, workerData } from 'node:worker_threads'
import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { z } from 'zod'
import { EditorRecoveryDatabase } from './editor-recovery-database'
import { editorRecoveryRequestSchema, type EditorRecoveryCommand } from './editor-recovery-protocol'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'

const { databasePath } = z.object({ databasePath: z.string() }).parse(workerData)
const database = new EditorRecoveryDatabase(databasePath)
if (!parentPort) {
  throw new Error('Recovery writer requires a worker port')
}
const port = parentPort

function execute(command: EditorRecoveryCommand): unknown {
  switch (command.kind) {
    case 'list':
      return database.list()
    case 'read':
      return database.read(command.id)
    case 'status':
      return database.status(command.ids)
    case 'apply':
      return database.apply(command.changes)
    case 'import':
      return database.importLegacy(command.drafts)
    case 'restore':
      return {
        drafts: command.resources.map((metadata) => database.latestActive(metadata)),
        resolvedIds: database
          .status(command.checkpointIds)
          .filter((entry) => entry.state === 'resolved')
          .map((entry) => entry.id)
      }
    case 'export': {
      const draft = database.read(command.id)
      if (!draft || draft.revision !== command.revision) {
        throw new Error('This draft changed. Refresh the recovery list before exporting.')
      }
      const canonical = (path: string): string => {
        try {
          return realpathSync.native(path)
        } catch {
          return resolve(path)
        }
      }
      const source =
        draft.hostId === 'local' && !draft.runtimeEnvironmentId
          ? canonical(draft.filePath)
          : resolve(draft.filePath)
      if (canonical(command.targetPath) === source) {
        throw new Error('Choose a separate file for the recovered copy.')
      }
      writeFileDurableSync(
        durableWriteTempPath(command.targetPath),
        command.targetPath,
        draft.content
      )
      return command.targetPath
    }
    case 'close':
      database.close()
      return undefined
  }
}

port.on('message', (message: unknown) => {
  const request = editorRecoveryRequestSchema.parse(message)
  try {
    const result = execute(request.command)
    port.postMessage({ requestId: request.requestId, ok: true, result })
    if (request.command.kind === 'close') {
      port.close()
    }
  } catch (error) {
    port.postMessage({
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
})

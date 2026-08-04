import { randomUUID } from 'node:crypto'
import {
  FILESYSTEM_HOST_PROTOCOL_VERSION,
  filesystemHostParentMessageSchema,
  type FilesystemHostChildMessage
} from '../../shared/filesystem-host-protocol'
import {
  executeFilesystemHostOperation,
  FilesystemHostOperationError
} from './filesystem-host-operation'

function send(message: FilesystemHostChildMessage): void {
  try {
    process.send?.(message)
  } catch {
    process.exitCode = 1
  }
}

function runSelfTest(): void {
  process.stdout.write(`${JSON.stringify({ protocolVersion: FILESYSTEM_HOST_PROTOCOL_VERSION })}\n`)
}

function main(): void {
  if (process.argv.includes('--self-test')) {
    runSelfTest()
    return
  }
  if (!process.send) {
    process.stderr.write('filesystem-host-entry requires an IPC channel\n')
    process.exitCode = 2
    return
  }

  const workerId = randomUUID()
  let shuttingDown = false
  process.on('disconnect', () => {
    process.exit(0)
  })
  process.on('message', (raw) => {
    const parsed = filesystemHostParentMessageSchema.safeParse(raw)
    if (!parsed.success) {
      return
    }
    const message = parsed.data
    if (message.type === 'shutdown') {
      shuttingDown = true
      process.exit(0)
    }
    if (shuttingDown || message.type !== 'request') {
      return
    }
    try {
      send({
        type: 'result',
        requestId: message.requestId,
        ok: true,
        result: executeFilesystemHostOperation(message.operation)
      })
    } catch (error) {
      const failure =
        error instanceof FilesystemHostOperationError
          ? error
          : new FilesystemHostOperationError('io', 'Filesystem operation failed')
      send({
        type: 'result',
        requestId: message.requestId,
        ok: false,
        error: { code: failure.code, message: failure.message }
      })
    }
  })
  send({ type: 'ready', protocolVersion: FILESYSTEM_HOST_PROTOCOL_VERSION, workerId })
}

main()

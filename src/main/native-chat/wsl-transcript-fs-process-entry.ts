// Forked so a killed WSL UNC syscall cannot retain a libuv thread in Orca.
import type {
  WslTranscriptFsProcessError,
  WslTranscriptFsProcessRequest,
  WslTranscriptFsProcessResponse
} from './wsl-transcript-fs-process-protocol'
import { WslTranscriptFsProcessOperations } from './wsl-transcript-fs-process-operations'

const operations = new WslTranscriptFsProcessOperations()

function serializeError(error: unknown): WslTranscriptFsProcessError {
  const value = error as NodeJS.ErrnoException | null
  return {
    name: value?.name ?? 'Error',
    message: value?.message ?? String(error),
    ...(typeof value?.code === 'string' ? { code: value.code } : {}),
    ...(typeof value?.errno === 'number' ? { errno: value.errno } : {}),
    ...(typeof value?.syscall === 'string' ? { syscall: value.syscall } : {}),
    ...(typeof value?.path === 'string' ? { path: value.path } : {})
  }
}

function respond(response: WslTranscriptFsProcessResponse): void {
  try {
    // Consume async channel-send errors so teardown cannot crash the helper.
    process.send?.(response, () => {})
  } catch {
    // Parent teardown closed the channel; disconnect exits.
  }
}

process.on('message', (request: WslTranscriptFsProcessRequest) => {
  void operations.execute(request).then(
    (value) => respond({ id: request.id, ok: true, value }),
    (error: unknown) => respond({ id: request.id, ok: false, error: serializeError(error) })
  )
})

process.on('disconnect', () => process.exit(0))

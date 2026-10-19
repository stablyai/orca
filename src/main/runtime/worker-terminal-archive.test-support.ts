import { vi } from 'vitest'
import { createRuntime, syncSinglePty } from './orca-runtime-test-fixtures.spec'
import { captureWorkerOutputArchive } from './orchestration/worker-output-archive'

// Synthetic normal-screen output; this exercises capture, not agent prompt detection.
export const ARCHIVE_SCREEN_LINES = [
  'Worker startup diagnostic',
  'Would you like to grant these permissions?',
  '1. Yes, grant these permissions for this turn',
  '2. No, continue without permissions',
  'Press enter to confirm or esc to cancel'
]

export async function createTerminalArchiveFixture(
  options: {
    screenLines?: string[]
    alternate?: boolean
    hydrate?: boolean
    provider?: boolean
    cols?: number
    rows?: number
  } = {}
) {
  const runtime = createRuntime()
  const snapshot = {
    data: `${options.alternate ? '\x1b[?1049h' : ''}${(options.screenLines ?? ARCHIVE_SCREEN_LINES).join('\r\n')}\r\n`,
    cols: options.cols ?? 100,
    rows: options.rows ?? 30
  }
  const serializeProviderBuffer = vi.fn(async () => ({
    ...snapshot,
    seq: runtime.getPtyOutputSequence('pty-1'),
    source: 'headless' as const,
    alternateScreen: options.alternate ?? false
  }))
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'codex',
    hasRendererSerializer: () => !options.provider && options.hydrate !== false,
    serializeBuffer: async () => snapshot,
    ...(options.provider ? { serializeProviderBuffer } : {}),
    getSize: () => ({ cols: options.cols ?? 100, rows: options.rows ?? 30 })
  })
  syncSinglePty(runtime)
  const [terminal] = (await runtime.listTerminals()).terminals
  if (!terminal) {
    throw new Error('No fixture terminal')
  }
  if (options.provider) {
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
  }
  vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
  return {
    runtime,
    handle: terminal.handle,
    serializeProviderBuffer,
    capture: () =>
      captureWorkerOutputArchive({
        runtime,
        terminalHandle: terminal.handle,
        dispatchId: 'ctx_archive',
        attachedAtMs: 0
      })
  }
}

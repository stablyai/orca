import { readTerminalImageCellSize } from '../../../shared/terminal-image-cell-size'
import { resolveTerminalInlineImagesEnabled } from '../../../shared/terminal-inline-images-settings'
import type { PtySpawnOptions } from '../../providers/types'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

export function ptySpawnImageCalibration(
  request: { connectionId?: string | null; terminalImageCellSize?: unknown },
  enabled: boolean | null | undefined
): Pick<PtySpawnOptions, 'terminalImageCellSize'> {
  if (request.connectionId || !resolveTerminalInlineImagesEnabled(enabled)) {
    return {}
  }
  const cellSize = readTerminalImageCellSize(request.terminalImageCellSize)
  return cellSize ? { terminalImageCellSize: cellSize } : {}
}

export function prepareDaemonPtySpawnImages(
  runtime: OrcaRuntimeService | undefined,
  ptyId: string | undefined,
  wslDistro: string | null,
  options: PtySpawnOptions,
  fresh: boolean
): void {
  if (!fresh || !ptyId || !options.terminalImageCellSize) {
    return
  }
  runtime?.preparePtyExecutionContext(ptyId, wslDistro, {
    resetIncarnation: true,
    size: { cols: options.cols, rows: options.rows },
    imageCellSize: options.terminalImageCellSize
  })
}

import type { RendererProcessMemory } from '../shared/renderer-process-memory'

type ProcessMemorySource = Pick<NodeJS.Process, 'getProcessMemoryInfo'>

/**
 * Reads this renderer's OS-level footprint. Available in a sandboxed,
 * context-isolated preload; resolves null when the runtime withholds it so a
 * dropped Electron API can never break renderer diagnostics.
 */
export async function readRendererProcessMemory(
  source: ProcessMemorySource = process
): Promise<RendererProcessMemory | null> {
  try {
    const info = await source.getProcessMemoryInfo()
    if (!isFiniteKilobytes(info?.private)) {
      return null
    }
    return {
      privateKB: info.private,
      // Why optional: Chromium reports no resident set on macOS.
      ...(isFiniteKilobytes(info.residentSet) ? { residentKB: info.residentSet } : {})
    }
  } catch {
    return null
  }
}

function isFiniteKilobytes(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
